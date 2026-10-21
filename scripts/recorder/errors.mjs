// A failure the recorder reports as one stderr line and a fixed exit code
// (the table is in main.mjs's usage text). Messages name paths and item ids,
// never a token value.
export class RecorderError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}
