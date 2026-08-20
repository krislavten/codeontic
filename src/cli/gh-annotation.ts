/**
 * GitHub Actions error annotations, on stdout.
 *
 * WHY AN ADVISORY COMMAND NEEDS ONE. `report` and `drift-report` exit 0 whatever
 * they find — a reading that blocks is a reading people learn to route around.
 * That leaves one state invisible: when the reading did not HAPPEN (the adapter
 * never loaded, the base was never checked out), the step is green and the only
 * trace is a line in a summary nobody opens. An annotation shows up on the PR
 * itself without failing anything, which is the one channel that separates
 * "管线坏了" from "没查出问题" while keeping the tier advisory.
 *
 * WHY IT LIVES HERE AND NOT IN THE CALLER. The adopting workflow used to build
 * this itself, and structurally could not do it cleanly: the engine's stdout is
 * also its human-readable output, so the workflow wrote the annotation into the
 * same stream it was rendering, then split it back out with a pair of greps
 * (`grep '^::error'` to a real stdout, `grep -v '^::error'` to the summary). Get
 * that pair wrong in either direction and you either lose the annotation or leak
 * a bare `::error` line into the summary body. Emitting from here deletes both
 * the greps and the failure mode — and, more to the point, the CONDITION for
 * emitting ("did this reading actually happen?") is engine knowledge that a
 * consumer can only approximate by scraping text.
 */

/** `%`, CR and LF are the three characters that terminate/confuse a command. */
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Property values additionally cannot carry the `:` / `,` that delimit them. */
function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function errorAnnotation(title: string, message: string): string {
  return `::error title=${escapeProperty(title)}::${escapeData(message)}`;
}
