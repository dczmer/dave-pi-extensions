# question

Ask the user a single multiple-choice question with an always-available
free-form escape hatch. The tool renders a title, an optional description,
and a menu of options, and blocks until you pick one (or type your own
answer).

It is meant to be called by you (the model) when a decision genuinely
requires human input — a fork in approach, a missing preference, or a
confirmation that is too important to assume. Because it always offers a
"Type a response" option, the user can always override the choices you
proposed.

## The `question` tool

```json
{
  "title": "Which database should I use?",
  "description": "This affects the schema and deployment story.",
  "options": [
    { "label": "Postgres", "description": "Relational, mature ecosystem" },
    { "label": "SQLite", "description": "Single file, zero-config" }
  ]
}
```

Parameters:

| Parameter     | Required | Meaning                                                       |
| ------------- | -------- | ------------------------------------------------------------- |
| `title`       | yes      | Short title shown bold at the top of the prompt.              |
| `description` | no       | Extra context shown under the title.                          |
| `options`     | yes      | Menu options (`label`, optional `description`), at least one. |
| `allowOther`  | no       | Show the free-form "Type a response" row. Default `true`.     |

## Navigation

- `↑` / `↓` — move the selection (wraps around).
- `Enter` — accept the highlighted option, or open the free-form editor when
  the "Type a response" row is highlighted.
- `Escape` — cancel the question (in the free-form editor, return to the menu).

In the editor, `Enter` submits the typed answer. An empty answer returns you
to the menu instead of submitting.

## Result

The tool resolves with a one-line answer and structured details:

- **Option selected** — `Answer: 2. SQLite` (details carry the option's
  index, label, and description).
- **Free-form answer** — `Answer: <your text>`.
- **Cancelled** — `The user declined to answer.` The tool does not treat a
  cancellation as an error; it returns this so you can proceed or re-ask.

The question runs sequentially (it cannot overlap other tool calls) and
requires an interactive TUI session; in a non-interactive mode the call fails
with a clear error instead of hanging.
