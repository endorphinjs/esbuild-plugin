type HelpersMap = Record<string, string[]>;
type EndorphinCompileOptions = import('@endorphinjs/template-compiler').CompileOptions;

interface EndorphinPluginOptions {
    /** Additional options for template compiler */
    template?: EndorphinCompileOptions;

    /** List of helper files */
    helpers?: string[];

    /** Generates component name from given module identifier */
    componentName?: (id: string) => string;

    /** Options for CSS processing */
    css?: EndorphinCSSOptions;
}

type TransformedResource = string | Buffer | {
    code?: string | Buffer,
    css?: string | Buffer,
    map?: any
};

interface ResourceTransformer {
    (type: string, code: string, filename: string): TransformedResource | Promise<TransformedResource>;
}

interface CSSBundleHandler {
    (code: string, map?: import('source-map').SourceMapGenerator): void;
}

interface EndorphinCSSOptions {
    /** A function to transform stylesheet code. */
    preprocess?: ResourceTransformer;

    /** A function that returns a CSS scope token from given component file path */
    scope?: (fileName: string) => string;

    /** CSS bundle and its source map */
    bundle?: CSSBundleHandler;
}

interface ProcessStylesheetOptions {
    scope: string;
    file: string;
    type?: 'scss' | 'css';
    sourceMap?: boolean;
    classScope?: EndorphinCompileOptions['classScope']
}

interface ComponentResource {
    url: string;
    content?: string;
    type?: string;
}

interface Line {
    start: number;
    end: number;
}

interface ENDSourceNode {
    mime: string;
    content?: string;
    url?: string;
}

type CacheKey = string | number;

interface CacheEntry {
    cacheKey: CacheKey;
    source: string;
    code: string;
    deps?: Map<string, CacheKey>;
    warnings?: import('esbuild').PartialMessage[];
    map?: any;
}

interface TemplateCacheEntry extends CacheEntry {
    scripts: ComponentResource[];
    styles: ComponentResource[];
    styleCache: Map<string, CacheEntry>;
}

interface WarningMessage {
    message: string;
    pos: number;
}

interface ProcessedStylesheet {
    deps: string[];
    code: string;
}