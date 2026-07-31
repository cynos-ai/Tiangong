export class PracticeRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PracticeRunError";
    this.code = code;
  }
}

export function practiceRunFail(code, message) {
  throw new PracticeRunError(code, message);
}
