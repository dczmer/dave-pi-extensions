all

# Allow lazy numbering: 1. 1. 1. — easier to reformat without renumbering.
rule "MD029", :style => "one"

# Allow 4-space indentation for nested unordered lists.
rule "MD007", :indent => 4

# Allow bullets.vim style: different unordered bullet chars at different nesting levels.
rule "MD004", :style => :sublist

# Disable line length — mdl cannot ignore code blocks, and README/docs contain
# long URLs and fenced code snippets that are better left unwrapped.
exclude_rule "MD013"

# Allow multiple top-level headers in the same document (e.g., per-section H1s).
exclude_rule "MD025"

# Allow trailing punctuation in headers (questions, ellipses, etc.).
exclude_rule "MD026"
