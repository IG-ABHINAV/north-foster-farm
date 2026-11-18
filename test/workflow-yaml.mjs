// Reads a GitHub workflow file into plain objects, for tests that
// check what a workflow says (#615). Only the YAML the workflows use:
// block maps and sequences, `|` and `>` block scalars, quoted and
// plain scalars, comments. Every value stays a string, as written:
// `passes: 1` reads "1", and a flow list like `[plan, full]` reads as
// its text. Anything else throws, naming the line, so a workflow that
// outgrows it fails loudly instead of being misread.

const indentOf = (line) => line.match(/^ */)[0].length;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);
const isItem = (line) => /^\s*-(\s|$)/.test(line);
const KEY = /^("[^"]*"|'[^']*'|[^\s"'#][^:]*?):(?:\s+(.*))?$/;
const BLOCK = /^([|>])([-+]?)\s*(#.*)?$/;

export const scalar = (text) => {
  const s = text.trim();

  if (s.startsWith("\"")) {
    return JSON.parse(s.match(/^"(?:[^"\\]|\\.)*"/)[0]);
  }
  if (s.startsWith("'")) {
    return s.match(/^'(?:[^']|'')*'/)[0].slice(1, -1).replace(/''/g, "'");
  }

  return s.replace(/\s+#.*$/, "");
};

// A folded scalar: lines join with a space, a blank line is a newline,
// and a more-indented line keeps its line breaks.
const fold = (lines) => lines.reduce((text, line, i) => {
  if (line === "") return `${text}\n`;
  if (text === "" || text.endsWith("\n")) return text + line;
  if (/^\s/.test(line) || /^\s/.test(lines[i - 1])) return `${text}\n${line}`;

  return `${text} ${line}`;
}, "");

export const parseYaml = (source) => {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let pos = 0;

  const peek = () => {
    while (pos < lines.length && isBlank(lines[pos])) pos += 1;

    return pos < lines.length ? lines[pos] : null;
  };
  const fail = (why) => {
    throw new Error(`workflow-yaml: line ${pos + 1}: ${why}: ${lines[pos]}`);
  };

  const block = (style, chomp, parent) => {
    const body = [];
    let indent = null;

    while (pos < lines.length) {
      const line = lines[pos];

      if (line.trim() === "") {
        body.push("");
      } else if (indentOf(line) <= parent) {
        break;
      } else {
        if (indent === null) indent = indentOf(line);
        body.push(line.slice(indent));
      }
      pos += 1;
    }
    while (body.length && body.at(-1) === "") body.pop();

    const text = style === "|" ? body.join("\n") : fold(body);

    return chomp === "-" ? text : `${text}\n`;
  };

  // A map or a sequence, whichever starts at the next line. Called only
  // after map and seq below are defined.
  const node = () => {
    const line = peek();

    if (line === null) return null;

    return isItem(line) ? seq(indentOf(line)) : map(indentOf(line));
  };

  const map = (indent) => {
    const out = {};

    for (let line = peek(); line !== null; line = peek()) {
      if (indentOf(line) !== indent || isItem(line)) break;
      const m = line.slice(indent).match(KEY);

      if (!m) fail("not a key");
      const key = scalar(m[1]);
      const rest = m[2] || "";

      pos += 1;
      const style = rest.match(BLOCK);

      if (style) {
        out[key] = block(style[1], style[2], indent);
      } else if (isBlank(rest)) {
        const next = peek();
        const nested = next !== null && (indentOf(next) > indent
          || (indentOf(next) === indent && isItem(next)));

        out[key] = nested ? node() : null;
      } else if (rest.trim().startsWith("[") || rest.trim().startsWith("{")) {
        out[key] = rest.replace(/\s+#.*$/, "").trim();
      } else {
        out[key] = scalar(rest);
      }
    }

    return out;
  };

  const seq = (indent) => {
    const out = [];

    for (let line = peek(); line !== null; line = peek()) {
      if (indentOf(line) !== indent || !isItem(line)) break;
      const dash = line.match(/^\s*-\s*/)[0].length;
      const content = line.slice(dash);

      if (isBlank(content)) {
        pos += 1;
        out.push(node());
      } else if (KEY.test(content)) {
        lines[pos] = " ".repeat(dash) + content;
        out.push(map(dash));
      } else {
        pos += 1;
        out.push(scalar(content));
      }
    }

    return out;
  };

  const doc = node();

  if (peek() !== null) fail("left over");

  return doc;
};
