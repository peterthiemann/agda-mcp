import readline from "node:readline";

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", () => {
  // Deliberately ignore both the active command and Cmd_abort.
});
process.stdout.write("JSON> ");
