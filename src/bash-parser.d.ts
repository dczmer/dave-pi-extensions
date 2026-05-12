declare module 'bash-parser' {
  interface ParseOptions {
    mode?: 'posix' | 'bash' | 'word-expansion';
    insertLOC?: boolean;
  }
  function parse(source: string, options?: ParseOptions): unknown;
  export = parse;
}
