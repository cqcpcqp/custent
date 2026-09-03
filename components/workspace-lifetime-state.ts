export function nextWorkspaceGeneration(currentGeneration: number): number {
  const nextGeneration = currentGeneration + 1;
  if (!Number.isSafeInteger(nextGeneration)) {
    throw new Error("工作区 generation 已超出安全整数范围");
  }
  return nextGeneration;
}

export function workspaceGenerationIsCurrent(
  currentGeneration: number,
  operationGeneration: number,
): boolean {
  return currentGeneration === operationGeneration;
}
