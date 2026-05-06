declare module "bash-parser" {
  interface Loc {
    start: { col: number; row: number; char: number };
    end: { col: number; row: number; char: number };
  }

  interface AstNode {
    type: string;
    loc?: Loc;
    [key: string]: unknown;
  }

  interface AstScript extends AstNode {
    type: "Script";
    commands: AstNode[];
  }

  interface ParseOptions {
    mode?: "posix" | "bash" | "word-expansion";
    insertLOC?: boolean;
  }

  function parse(source: string, options?: ParseOptions): AstScript;
  export = parse;
}
