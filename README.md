Minimalist pi extensions, favoring deterministic code over internal prompting logic, and aggressively minimizing external dependencies.

I'd like to say "no external dependencies" besides the pi SDK and node built-ins, but I think it might be worth adding something like https://github.com/vorpaljs/bash-parser/tree/master to improve the plan-mode and pi-gate extensions by more accurately parsing bash commands instead of trying to do it with regexes. That library has 21 dependencies, but they _look_ pretty reasonable - as long as there is not a long mess of transitive dependencies.

Alternatively, we could send the bash command strings to another small agent to parse them but this seems like overkill at the moment.

Honestly, the thing adding the most external dependencies to this project is the pi SDK itself. I don't see why we need to install all of the various dependencies for the agent itself when we only want to interact with the TUI extensions API. I wish they would split this into multiple packages so I could avoid having so many extra dependencies for this pi package.
