import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let loads = 0;

function respond(events) {
  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\n")}\nJSON> `);
}

process.stdout.write("JSON> ");

lines.on("line", (line) => {
  if (line.includes("Cmd_load")) {
    loads += 1;
    if (loads > 1) {
      process.exit(9);
      return;
    }
    respond([
      { kind: "Status", status: { checked: true } },
      {
        kind: "DisplayInfo",
        info: {
          kind: "AllGoalsWarnings",
          errors: [],
          warnings: [],
          invisibleGoals: [],
          visibleGoals: [{
            kind: "OfType",
            type: "A",
            constraintObj: {
              id: 0,
              range: [{
                start: { line: 4, col: 8, pos: 50 },
                end: { line: 4, col: 15, pos: 57 },
              }],
            },
          }],
        },
      },
      {
        kind: "InteractionPoints",
        interactionPoints: [{
          id: 0,
          range: [{
            start: { line: 4, col: 8, pos: 50 },
            end: { line: 4, col: 15, pos: 57 },
          }],
        }],
      },
    ]);
    return;
  }
  if (line.includes("Cmd_refine_or_intro")) {
    respond([{ kind: "GiveAction", giveResult: { str: "x" } }]);
    return;
  }
  respond([]);
});
