import path from 'node:path';
import fs from 'node:fs/promises';
import sass from 'sass';
import ts from 'typescript';
import { parse, generate, scopeCSS } from 'endorphin/compiler.js';
import { safeBase64Hash } from './utils/hash.js';

/** @type {EndorphinPluginOptions} */
const defaultOptions = {
    componentName(id) {
        const fileName = path.basename(id, path.extname(id));
        return fileName === 'index' ? path.dirname(id) : fileName;
    },
    css: {
        scope(filePath) {
            return 'e' + safeBase64Hash(filePath);
        }
    }
};

/**
 * @param {Partial<EndorphinPluginOptions>} options
 * @returns {import('esbuild').Plugin}
 */
export default function createPlugin(options = {}) {
    options = {
        ...defaultOptions,
        ...options,
        css: {
            ...defaultOptions.css,
            ...options.css
        }
    };

    /** @type {Map<string, TemplateCacheEntry>} */
    const templateCache = new Map();

    /** @type {Map<string, CacheEntry>} */
    const styleCache = new Map();

    /** @type {Map<string, CacheKey>} */
    const fileKeyCache = new Map();

    /**
     * Returns file unique identifier which may be used to detect changes in file
     * @param {string} filePath
     * @returns {Promise<CacheKey>}
     */
    async function getCacheKey(filePath) {
        let value = fileKeyCache.get(filePath);
        if (value == null) {
            const stats = await fs.stat(filePath);
            value = `${stats.ino}:${stats.mtimeMs}`;
        }

        return value;
    }

    /**
     * Проверяет, является ли валидной указанная запись в кэше
     * @param {CacheEntry} entry
     * @param {CacheKey} cacheKey
     * @returns {Promise<boolean>}
     */
    async function isValidEntry(entry, cacheKey) {
        if (entry.cacheKey !== cacheKey) {
            return false;
        }

        if (entry.deps?.size) {
            for (const [k, v] of entry.deps) {
                if (v !== await getCacheKey(k)) {
                    return false;
                }
            }
        }

        return true;
    }

    return {
        name: 'Endorphin loader',
        async setup(build) {
            /** @type {HelpersMap} */
            const helpers = {};

            if (options.helpers) {
                for (const helper of options.helpers) {
                    const contents = await fs.readFile(helper, 'utf8');
                    helpers[helper] = getSymbols(helper, contents);
                }

                options.template = {
                    ...options.template,
                    helpers
                };
            }

            /**
             * Загружает и преобразуется CSS в контексте шаблона компонента.
             * Учитывается существующий кэш
             * @param {string} url
             * @param {string | null} source
             * @param {'scss' | 'css'} type
             * @param {Map<string, CacheEntry>} cache
             * @returns {Promise<CacheEntry | undefined>}
             */
            const loadStylesheet = async (url, source, type, cache) => {
                let cacheEntry = cache.get(url);
                const { file, query } = splitUrl(url);
                const cacheKey = await getCacheKey(file);

                if (!cacheEntry || !await isValidEntry(cacheEntry, cacheKey)) {
                    if (source === null) {
                        source = await fs.readFile(file, 'utf8');
                    }

                    const processed = await processStylesheet(source, {
                        file,
                        scope: query.get('scope') || '',
                        type,
                        sourceMap: !!build.initialOptions.sourcemap,
                        classScope: options.template?.classScope
                    });

                    /** @type {Map<string, CacheKey>} */
                    const deps = new Map();

                    for (const d of processed.deps) {
                        deps.set(d, await getCacheKey(d));
                    }

                    cacheEntry = {
                        cacheKey,
                        source,
                        deps,
                        code: processed.code,
                    };
                    cache.set(url, cacheEntry);
                }

                return cacheEntry;
            };

            build.onStart(() => {
                fileKeyCache.clear();
            });

            build.onLoad({ filter: /\.html$/ }, async args => {
                let compiledTemplate = templateCache.get(args.path);

                if (args.suffix) {
                    if (!compiledTemplate) {
                        throw new Error(`Unable to find parsed tamplate for ${args.path}`);
                    }

                    const query = new URLSearchParams(args.suffix);
                    const type = query.get('type');
                    const i = query.has('i') ? Number(query.get('i')) : -1;

                    if (type === 'componentStylesheet') {
                        const style = compiledTemplate.styles[i];
                        if (style?.content) {
                            const url = getAbsoluteUrl(args);
                            const cacheEntry = await loadStylesheet(
                                    url,
                                    style.content,
                                    style.type === 'scss' ? 'scss' : 'css',
                                    compiledTemplate.styleCache);
                            if (cacheEntry) {
                                return toCSSOnLoad(cacheEntry);
                            } else {
                                console.warn('No inline stylesheet');
                            }
                        }
                    } else if (type === 'componentScript') {
                        // Get inline script
                        const script = compiledTemplate.scripts[i];
                        if (script?.content) {
                            return {
                                contents: script.content,
                                loader: script.type === 'ts' || script.type === 'typescript' ? 'ts' : 'js'
                            };
                        } else {
                            console.warn('No inline script');
                        }
                    }

                    return;
                }

                const cacheKey = await getCacheKey(args.path);

                if (!compiledTemplate || !await isValidEntry(compiledTemplate, cacheKey)) {
                    compiledTemplate = await compileTemplate(args.path, cacheKey, options);
                    templateCache.set(args.path, compiledTemplate);
                }

                return {
                    contents: compiledTemplate.code,
                    warnings: compiledTemplate.warnings,
                    loader: 'js',
                };
            });

            build.onLoad({ filter: /\.s?css(\?.+)?$/ }, async (args) => {
                const url = getAbsoluteUrl(args);
                const { file } = splitUrl(url);
                const cacheEntry = await loadStylesheet(url, null, path.extname(file) === '.scss' ? 'scss' : 'css', styleCache);

                return cacheEntry ? toCSSOnLoad(cacheEntry) : undefined;
            });
        },
    }
}

/**
 * @param {string} filename
 * @param {string} normalizedRoot
 * @returns {string}
 */
function normalize(filename, normalizedRoot) {
    return stripRoot(path.normalize(filename), normalizedRoot);
}

/**
 * @param {string} normalizedFilename
 * @param {string} normalizedRoot
 * @returns {string}
 */
function stripRoot(normalizedFilename, normalizedRoot) {
    return normalizedFilename.startsWith(normalizedRoot + '/')
        ? normalizedFilename.slice(normalizedRoot.length)
        : normalizedFilename;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function createScopeSuffix(filePath) {
    return 'e' + safeBase64Hash(filePath);
}

/**
 * @param {any} sm
 */
function sourceMapToDataURL(sm) {
    const data = Buffer.from(JSON.stringify(sm)).toString('base64');
    return `data:application/json;charset=utf-8;base64,${data}`;
}

/**
 * Processes given stylesheet file
 * @param {string} source
 * @param {ProcessStylesheetOptions} options
 * @returns {Promise<ProcessedStylesheet>}
 */
async function processStylesheet(source, options) {
    let code = source;
    let map = null;
    let deps = [];

    if (options.type === 'scss') {
        const compiled = await sass.compileStringAsync(code, {
            url: new URL(`file://${options.file}`),
            sourceMap: options.sourceMap
        });
        code = compiled.css;
        map = compiled.sourceMap;

        for (const url of compiled.loadedUrls) {
            deps.push(url.pathname);
        }
    }

    const transformed = await scopeCSS(code, options.scope, {
        filename: options.file,
        map,
        classScope: options.classScope
    });

    if (typeof transformed == 'string') {
        code = transformed;
    } else {
        code = transformed.code;
        map = transformed.map;
    }

    if (map) {
        code += `\n/*# sourceMappingURL=${sourceMapToDataURL(map)} */`;
    }

    return { deps, code };
}

/**
 * Returns list of exported symbols of given file
 * @param {string} name
 * @param {string} source
 * @returns {string[]}
 */
function getSymbols(name, source) {
    /** @type {string[]} */
    const result = [];
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest);
    file.statements.forEach(child => {
        if (ts.isExportDeclaration(child)) {
            // const a = 1;
            // const b = 2;
            // export { a, b as foo };
            if (child.exportClause && ts.isNamedExports(child.exportClause)) {
                child.exportClause.elements.forEach(exp => result.push(exp.name.text));
            }
        } else if (ts.isFunctionDeclaration(child) && child.name && hasExportsModifier(child)) {
            result.push(child.name.text);
        } else if (ts.isVariableStatement(child) && hasExportsModifier(child)) {
            child.declarationList.forEachChild(n => {
                if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
                    result.push(n.name.text);
                }
            });
        }
    });

    return result;
}

/**
 * @param {ts.FunctionDeclaration | ts.VariableStatement} node
 * @returns {boolean}
 */
function hasExportsModifier(node) {
    return !!node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)
}

/**
 * Get line locations of given text
 * @param {string} text
 * @returns {Line[]}
 */
function getLines(text) {
    let start = 0;
    let end = 0;

    /** @type {Line[]} */
    const result = [];

    while (end < text.length) {
        const ch = text[end++];
        if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && text[end] === '\n') {
                end++;
            }
            result.push({ start, end });
            start = end;
        }
    }

    if (start !== end) {
        result.push({ start, end });
    }

    return result;
}

/**
 * @param {ENDSourceNode} node
 * @returns {ComponentResource}
 */
function getComponentResource(node) {
    return {
        url: node.url,
        content: node.content,
        type: node.mime,
    };
}

/**
 * @param {import('esbuild').OnLoadArgs} args
 * @returns {string}
 */
function getAbsoluteUrl(args) {
    return args.path + (args.suffix || '');
}

/**
 * @param {string} url
 * @returns {{ file: string, query: URLSearchParams }}
 */
function splitUrl(url) {
    const [file, suffix] = url.split('?', 2);
    return {
        file,
        query: new URLSearchParams(suffix ? `?${suffix}` : '')
    };
}

/**
 *
 * @param {string} message Error message
 * @param {number} pos Error location in `code` (byte offset)
 * @param {string} code Original source code
 * @param {string} file Path to file with source code
 * @returns {import('esbuild').PartialMessage | undefined}
 */
function createMessage(message, pos, code, file) {
    const lines = getLines(code);
    const lineIx = lines.findIndex(line => line.start >= pos && line.end < pos)
    if (lineIx !== -1) {
        const line = lines[lineIx];
        return {
            text: message,
            location: {
                line: lineIx,
                column: pos - line.start,
                lineText: code.slice(line.start, line.end),
                file
            }
        };
    }

    return;
}

/**
 * @param {string} filePath
 * @param {string | number} cacheKey
 * @param {EndorphinPluginOptions} options
 * @returns {Promise<TemplateCacheEntry>}
 */
async function compileTemplate(filePath, cacheKey, options) {
    const root = process.cwd();
    const source = await fs.readFile(filePath, 'utf8');

    // const sourceMap = !!build.initialOptions.sourcemap;
    const normalizedFilename = normalize(filePath, root);

    /** @type {import('esbuild').PartialMessage[]} */
    const warnings = [];

    /** @type {EndorphinCompileOptions} */
    const compileOpt = {
        module: 'endorphin',
        cssScope: createScopeSuffix(normalizedFilename),
        component: options.componentName ? options.componentName(normalizedFilename) : '',
        warn: (message, pos = -1) => {
            const warning = createMessage(message, pos, source, filePath);
            if (warning) {
                warnings.push(warning);
            }
        },
        ...options.template
    }

    let header = '';


    const parsed = parse(source, filePath, compileOpt);
    const styles = parsed.ast.stylesheets.map(node => getComponentResource(node));
    const scripts = parsed.ast.scripts.map(node => getComponentResource(node));

    // Emit chunks for inline scripts
    scripts.forEach((res, i) => {
        if (res.content) {
            header += `export * from "${filePath}?type=componentScript&i=${i}";\n`;
            parsed.ast.scripts[i].content = undefined;
        }
    })

    // Emit chunks for styles
    styles.forEach((res, i) => {
        const suffix = res.content ? `&i=${i}` : '';
        header += `import "${res.url}?type=componentStylesheet&scope=${compileOpt.cssScope}${suffix}";\n`;
    });

    // Generate JavaScript code from template AST
    const result = generate(parsed, compileOpt);

    return {
        cacheKey,
        styles,
        scripts,
        source,
        warnings,
        styleCache: new Map(),
        // TODO add sourcemap (magicstring?)
        code: header + result.code,
        map: result.map
    };
}

/**
 * @param {CacheEntry} cacheEntry
 * @returns {import('esbuild').OnLoadResult}
 */
function toCSSOnLoad(cacheEntry) {
    /** @type {string[] | undefined} */
    let watchFiles;
    if (cacheEntry.deps) {
        watchFiles = Array.from(cacheEntry.deps.keys())
    }

    return {
        contents: cacheEntry.code,
        watchFiles,
        loader: 'css'
    };
}
