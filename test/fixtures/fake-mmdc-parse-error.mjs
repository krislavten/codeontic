// Stands in for mmdc rejecting a genuinely malformed diagram — the case that
// must keep reporting `invalid`, so the browser-launch carve-out can't quietly
// swallow real syntax errors too.
process.stderr.write(
  "Parse error on line 2:\nflowchart TB\n  A[\n     ^\nExpecting 'SQE', got 'EOF'\n",
);
process.exit(1);
