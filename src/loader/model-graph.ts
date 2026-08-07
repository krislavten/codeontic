import type {
  DebtEntry,
  Feature,
  Flow,
  Junction,
  Loop,
  ModelNode,
  Scenario,
} from "../schema/index.js";

/**
 * A single successfully-parsed node together with the file it came from.
 * This is the raw ingredient both the graph builder and the T0 checker
 * (ID uniqueness in particular) need — keeping it as a flat list first
 * means "two nodes share an id" is representable before we collapse
 * anything into a Map.
 */
export interface ModelEntry {
  node: ModelNode;
  file: string;
}

export interface ModelGraph {
  byKind: {
    feature: Map<string, Feature>;
    flow: Map<string, Flow>;
    loop: Map<string, Loop>;
    junction: Map<string, Junction>;
    scenario: Map<string, Scenario>;
    debt: Map<string, DebtEntry>;
  };
  /** Source file each id was loaded from (first occurrence wins on duplicates). */
  sourceFile: Map<string, string>;
}

export interface DuplicateId {
  id: string;
  files: string[];
}

export function createEmptyGraph(): ModelGraph {
  return {
    byKind: {
      feature: new Map(),
      flow: new Map(),
      loop: new Map(),
      junction: new Map(),
      scenario: new Map(),
      debt: new Map(),
    },
    sourceFile: new Map(),
  };
}

/**
 * Builds a ModelGraph from a flat list of parsed entries. Duplicate ids
 * (same id appearing in more than one entry, whether same kind or not)
 * are reported rather than silently overwritten — first occurrence wins
 * in the graph, but every duplicate is surfaced so T0's ID-uniqueness
 * check can fail the build.
 */
export function buildGraph(entries: ModelEntry[]): {
  graph: ModelGraph;
  duplicateIds: DuplicateId[];
} {
  const graph = createEmptyGraph();
  const filesById = new Map<string, string[]>();

  for (const { node, file } of entries) {
    const existing = filesById.get(node.id);
    if (existing) {
      existing.push(file);
      continue;
    }
    filesById.set(node.id, [file]);
    graph.sourceFile.set(node.id, file);
    switch (node.kind) {
      case "feature":
        graph.byKind.feature.set(node.id, node);
        break;
      case "flow":
        graph.byKind.flow.set(node.id, node);
        break;
      case "loop":
        graph.byKind.loop.set(node.id, node);
        break;
      case "junction":
        graph.byKind.junction.set(node.id, node);
        break;
      case "scenario":
        graph.byKind.scenario.set(node.id, node);
        break;
      case "debt":
        graph.byKind.debt.set(node.id, node);
        break;
    }
  }

  const duplicateIds: DuplicateId[] = [];
  for (const [id, files] of filesById) {
    if (files.length > 1) duplicateIds.push({ id, files });
  }

  return { graph, duplicateIds };
}

export function getNode(graph: ModelGraph, id: string): ModelNode | undefined {
  return (
    graph.byKind.feature.get(id) ??
    graph.byKind.flow.get(id) ??
    graph.byKind.loop.get(id) ??
    graph.byKind.junction.get(id) ??
    graph.byKind.scenario.get(id) ??
    graph.byKind.debt.get(id)
  );
}

export function allNodes(graph: ModelGraph): ModelNode[] {
  return [
    ...graph.byKind.feature.values(),
    ...graph.byKind.flow.values(),
    ...graph.byKind.loop.values(),
    ...graph.byKind.junction.values(),
    ...graph.byKind.scenario.values(),
    ...graph.byKind.debt.values(),
  ];
}
