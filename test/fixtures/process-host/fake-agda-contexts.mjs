import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingMetas;

function respond(events, prefix = "") {
  const output = events.map((event) => JSON.stringify(event)).join("\n");
  process.stdout.write(`${prefix}${output}${output === "" ? "" : "\n"}JSON> `);
}

process.stdout.write("JSON> ");

lines.on("line", (line) => {
  if (line.includes("Cmd_abort")) {
    if (pendingMetas !== undefined) clearTimeout(pendingMetas);
    pendingMetas = undefined;
    respond([{ kind: "DoneAborting" }]);
    return;
  }

  if (line.includes("Cmd_load")) {
    respond([
      { kind: "Status", status: { checked: false } },
      {
        info: {
          errors: [],
          invisibleGoals: [],
          kind: "AllGoalsWarnings",
          visibleGoals: [
            {
              constraintObj: {
                id: 0,
                range: [
                  {
                    start: { line: 4, col: 8, pos: 50 },
                    end: { line: 4, col: 15, pos: 57 },
                  },
                ],
              },
              kind: "OfType",
              type: "A",
            },
          ],
          warnings: [],
        },
        kind: "DisplayInfo",
      },
      {
        interactionPoints: [
          {
            id: 0,
            range: [
              {
                start: { line: 4, col: 8, pos: 50 },
                end: { line: 4, col: 15, pos: 57 },
              },
            ],
          },
        ],
        kind: "InteractionPoints",
      },
    ]);
    return;
  }

  if (line.includes("Cmd_metas")) {
    pendingMetas = setTimeout(() => {
      pendingMetas = undefined;
      respond([{ kind: "Metas", values: [] }]);
    }, 150);
    return;
  }

  if (line.includes("Cmd_constraints")) {
    process.stderr.write("stderr-diagnostic\n");
    respond(
      [
        { kind: "Status", status: { checked: true } },
        { kind: "FutureEvent", retained: true },
      ],
      "non-json notice\n",
    );
    return;
  }

  if (line.includes("Cmd_refine_or_intro")) {
    if (line.includes("reject-preview")) {
      respond([{ kind: "DisplayInfo", info: { kind: "Error", error: { message: "Rejected preview" } } }]);
      return;
    }
    const reply = () => respond([{ kind: "GiveAction", interactionPoint: { id: 0, range: [] }, giveResult: { str: "x" } }]);
    if (line.includes("slow-preview")) setTimeout(reply, 150);
    else reply();
    return;
  }

  if (line.includes("Cmd_autoOne")) {
    respond([{ kind: "GiveAction", interactionPoint: { id: 0, range: [] }, giveResult: { str: "x" } }]);
    return;
  }

  if (line.includes("Cmd_make_case")) {
    respond([{
      kind: "MakeCase",
      interactionPoint: { id: 0, range: [] },
      variant: "Function",
      clauses: ["id true = false", "id false = true"],
    }]);
    return;
  }

  if (line.includes("Cmd_compute_toplevel") && line.includes("stderr-flood")) {
    process.stderr.write("e".repeat(8192));
    return;
  }

  if (line.includes("Cmd_compute_toplevel") && line.includes("flood")) {
    process.stdout.write(`{"kind":"Flood","data":"${"x".repeat(8192)}`);
    return;
  }

  if (line.includes("Cmd_infer_toplevel") && line.includes("invalid")) {
    process.stdout.write("{bad}\nJSON> ");
    return;
  }

  if (line.includes("Cmd_infer_toplevel") && line.includes("malformed-command")) {
    process.stdout.write("cannot read: malformed-command\nJSON> ");
    return;
  }

  if (line.includes("Cmd_goal_type_context")) {
    respond([
      {
        kind: "DisplayInfo",
        info: {
          kind: "GoalSpecific",
          goalInfo: {
            kind: "GoalType",
            type: "Bool",
            entries: [
              { originalName: "x", reifiedName: "x", binding: "Bool", inScope: true },
            ],
          },
        },
      },
    ]);
    return;
  }

  respond([{ kind: "Echo", command: line }]);
});
