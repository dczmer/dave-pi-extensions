# dave-pi-extensions

Minimalist pi extensions, favoring deterministic code over internal prompting logic, and aggressively minimizing external dependencies.

## Dependencies

I'd like to say "no external dependencies" besides the pi SDK and node built-ins, but I decided to add [bash-parser](https://github.com/vorpaljs/bash-parser/tree/master) to improve the [plan-mode](./docs/extensions/plan-mode.md) and [pi-gate](./docs/extensions/pi-gate.md) extensions by more accurately parsing bash commands instead of trying to do it with regular expressions. This added a few transitive dependencies but they were all very simple and seemingly benign.

And then the "dev dependencies" add a ton of transitive dependencies but those are not part of the extensions a user would install.

I wish this used [Deno](https://deno.com/) because I like that all the dev tools are built-in (lint, test and assertions, format, type checking, etc) and that it has a standard library you can leverage to avoid the need for additional external dependencies.

Honestly, the thing adding the most external dependencies to this project is the pi SDK itself. I don't see why we need to install all of the various dependencies for the agent itself when we only want to interact with the TUI extensions API. I wish they would split this into multiple packages so I could avoid having so many extra dependencies for this pi package.

## context-usage-bar

![context-usage-bar](./docs/images/custom-context-bar.png)

Simple 1-line context bar with token usage, provider and model, git branch, and a color-coded context window "progress bar".

[Read more here](./docs/extensions/context-usage-bar.md).
