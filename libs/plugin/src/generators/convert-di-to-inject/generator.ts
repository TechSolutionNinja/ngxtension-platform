import {
	formatFiles,
	getProjects,
	logger,
	readJson,
	readProjectConfiguration,
	Tree,
	visitNotIgnoredFiles,
} from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { exit } from 'node:process';
import { VariableDeclarationKind } from 'ts-morph';
import { ContentsStore } from '../shared-utils/contents-store';
import { ConvertDiToInjectGeneratorSchema } from './schema';

function trackContents(
	tree: Tree,
	contentsStore: ContentsStore,
	fullPath: string,
) {
	if (fullPath.endsWith('.ts')) {
		const fileContent =
			tree.read(fullPath, 'utf8') || readFileSync(fullPath, 'utf8');

		if (
			!fileContent.includes('@Component') &&
			!fileContent.includes('constructor(') &&
			!fileContent.includes('@Pipe') &&
			!fileContent.includes('@Injectable') &&
			!fileContent.includes('@Directive')
		) {
			return;
		}

		if (fileContent.includes('constructor(')) {
			contentsStore.track(fullPath, fileContent);
		}
	}
}

function tokenIsTypeString(token: any) {
	// example: 'my-service' or "my-service"
	return token.includes("'") || token.includes('"');
}

export async function convertDiToInjectGenerator(
	tree: Tree,
	options: ConvertDiToInjectGeneratorSchema,
) {
	const contentsStore = new ContentsStore();
	const packageJson = readJson(tree, 'package.json');
	const angularCorePackage = packageJson['dependencies']['@angular/core'];

	if (!angularCorePackage) {
		logger.error(`[ngxtension] No @angular/core detected`);
		return exit(1);
	}

	const { path, project } = options;

	if (path && project) {
		logger.error(
			`[ngxtension] Cannot pass both "path" and "project" to convertDiToInjectGenerator`,
		);
		return exit(1);
	}

	if (path) {
		if (!tree.exists(path)) {
			logger.error(`[ngxtension] "${path}" does not exist`);
			return exit(1);
		}

		trackContents(tree, contentsStore, path);
	} else if (project) {
		try {
			const projectConfiguration = readProjectConfiguration(tree, project);

			if (!projectConfiguration) {
				throw `"${project}" project not found`;
			}

			visitNotIgnoredFiles(tree, projectConfiguration.root, (path) => {
				trackContents(tree, contentsStore, path);
			});
		} catch (err) {
			logger.error(`[ngxtension] ${err}`);
			return;
		}
	} else {
		const projects = getProjects(tree);
		for (const project of projects.values()) {
			visitNotIgnoredFiles(tree, project.root, (path) => {
				trackContents(tree, contentsStore, path);
			});
		}
	}

	for (const { path: sourcePath } of contentsStore.collection) {
		const sourceFile = contentsStore.project.getSourceFile(sourcePath)!;

		const hasInjectImport = sourceFile.getImportDeclaration(
			(importDecl) =>
				importDecl.getModuleSpecifierValue() === '@angular/core' &&
				importDecl
					.getNamedImports()
					.some((namedImport) => namedImport.getName() === 'inject'),
		);

		const classes = sourceFile.getClasses();

		for (const targetClass of classes) {
			const applicableDecorator = targetClass.getDecorator((decoratorDecl) => {
				return ['Component', 'Directive', 'Pipe', 'Injectable'].includes(
					decoratorDecl.getName(),
				);
			});
			if (!applicableDecorator) continue;

			const convertedDeps = new Set<string>();
			let includeHostAttributeToken = false;

			targetClass.getConstructors().forEach((constructor) => {
				constructor.getParameters().forEach((param, index) => {
					const { name, type, decorators, scope, isReadonly } =
						param.getStructure();

					let shouldUseType = false;
					let toBeInjected = type; // default to type
					let tokenToBeInjectedIsString = false;
					let isAttributeToken = false;
					const flags = [];

					if (decorators.length > 0) {
						decorators.forEach((decorator) => {
							if (decorator.name === 'Inject') {
								toBeInjected = decorator.arguments[0]; // use the argument of the @Inject decorator
								if (toBeInjected !== type) {
									shouldUseType = true;
								}

								if (tokenIsTypeString(toBeInjected)) {
									tokenToBeInjectedIsString = true;
								}
							}

							if (decorator.name === 'Attribute') {
								// ex: @Attribute('type') type: string
								toBeInjected = decorator.arguments[0];
								isAttributeToken = true;
								includeHostAttributeToken = true;
								shouldUseType = true;
							}

							if (decorator.name === 'Optional') {
								flags.push('optional');
							}
							if (decorator.name === 'Self') {
								flags.push('self');
							}
							if (decorator.name === 'SkipSelf') {
								flags.push('skipSelf');
							}
							if (decorator.name === 'Host') {
								flags.push('host');
							}
						});
					}

					// if type is (ElementRef or TemplateRef) or should use type, add it as inject generic

					let injection = 'inject';

					const typeHasGenerics = type?.toString().includes('<') ?? false;

					if (type && (shouldUseType || typeHasGenerics)) {
						injection += `<${type}>`;
					}

					let initializer = '';

					if (isAttributeToken) {
						// inject(new HostAttributeToken('some-attr'));
						initializer = `${injection}(new HostAttributeToken(${toBeInjected})${flags.length > 0 ? `, { ${flags.map((flag) => flag + ': true').join(', ')} }` : ''})`;
					} else {
						initializer = `${injection}(${toBeInjected}${tokenToBeInjectedIsString ? ' as any /* TODO(inject-migration): Please check if the type is correct */' : ''}${flags.length > 0 ? `, { ${flags.map((flag) => flag + ': true').join(', ')} }` : ''})`;
					}

					if (!scope) {
						// create the variable inside the constructor instead of creating it as a class property
						constructor.insertVariableStatement(0, {
							declarationKind: VariableDeclarationKind.Const,
							declarations: [{ name, initializer }],
						});
					} else {
						targetClass.insertProperty(index, {
							name,
							initializer,
							scope,
							isReadonly:
								isReadonly || options.includeReadonlyByDefault || false,
							leadingTrivia: '  ',
						});
					}

					convertedDeps.add(name);

					// check if service was used inside the constructor without 'this.' prefix
					// if so, add 'this.' prefix to the service

					// THIS IS NOT NEEDED as we don't convert the service to a class property
					// Leaving it here as it may be used in the future in other migrations
					// 	constructor.getStatements().forEach((statement) => {
					// 		if (Node.isExpressionStatement(statement)) {
					// 			const expression = statement.getExpression();
					// 			if (Node.isCallExpression(expression)) {
					// 				const expressionText = expression.getText();
					// 				if (
					// 					expressionText.includes(name.toString()) &&
					// 					!expressionText.includes(`this.${name.toString()}`)
					// 				) {
					// 					const newExpression = expressionText.replace(
					// 						name.toString(),
					// 						`this.${name}`,
					// 					);
					// 					statement.replaceWithText(newExpression);
					// 				}
					// 			}
					// 		}
					// 	});
				});

				if (convertedDeps.size > 0 && !hasInjectImport) {
					const namedImports = ['inject'];

					if (includeHostAttributeToken) {
						namedImports.push('HostAttributeToken');
					}

					const angularCoreImports = sourceFile.getImportDeclaration(
						(importDecl) => {
							return importDecl.getModuleSpecifierValue() === '@angular/core';
						},
					);
					if (angularCoreImports) {
						angularCoreImports.addNamedImports(namedImports);
					} else {
						sourceFile.insertImportDeclaration(0, {
							namedImports,
							moduleSpecifier: '@angular/core',
							leadingTrivia: '  ',
						});
					}
				}

				constructor.getParameters().forEach((param) => {
					if (convertedDeps.has(param.getName())) {
						param.remove();
					}
				});

				if (
					constructor.getParameters().length === 0 &&
					constructor.getBodyText().trim() === ''
				) {
					constructor.remove();
				}

				for (const decorator of [
					'Inject',
					'Attribute',
					'Optional',
					'Self',
					'SkipSelf',
					'Host',
				]) {
					// if @${Decorator} is not used anymore, remove the import
					const hasDecoratorUsage = sourceFile
						.getFullText()
						.includes(`@${decorator}`);
					if (!hasDecoratorUsage) {
						const foundImport = sourceFile.getImportDeclaration(
							(importDecl) =>
								importDecl.getModuleSpecifierValue() === '@angular/core' &&
								importDecl
									.getNamedImports()
									.some((namedImport) => namedImport.getName() === decorator),
						);

						if (foundImport) {
							const classToRemove = foundImport
								.getNamedImports()
								.find((namedImport) => namedImport.getName() === decorator);
							classToRemove.remove();
						}
					}
				}
			});
		}

		tree.write(sourcePath, sourceFile.getFullText());
	}

	await formatFiles(tree);

	logger.info(
		`
[ngxtension] Conversion completed. Please check the content and run your formatter as needed.
`,
	);
}

export default convertDiToInjectGenerator;
