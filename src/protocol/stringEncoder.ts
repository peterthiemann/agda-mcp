function hexadecimalEscape(codePoint: number): string {
  return `\\x${codePoint.toString(16)}\\&`;
}

export function encodeHaskellString(value: string): string {
  let encoded = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    switch (character) {
      case '"':
        encoded += '\\"';
        break;
      case "\\":
        encoded += "\\\\";
        break;
      case "\n":
        encoded += "\\n";
        break;
      case "\r":
        encoded += "\\r";
        break;
      case "\t":
        encoded += "\\t";
        break;
      case "\b":
        encoded += "\\b";
        break;
      case "\f":
        encoded += "\\f";
        break;
      case "\v":
        encoded += "\\v";
        break;
      case "\u0007":
        encoded += "\\a";
        break;
      default:
        encoded += codePoint >= 0x20 && codePoint < 0x7f ? character : hexadecimalEscape(codePoint);
    }
  }
  return `${encoded}"`;
}

export function encodeHaskellStringList(values: readonly string[]): string {
  return `[${values.map(encodeHaskellString).join(", ")}]`;
}
