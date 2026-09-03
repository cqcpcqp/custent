export class ResearchDataConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchDataConsistencyError";
  }
}
