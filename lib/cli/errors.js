export class UsageError extends Error {
  static exitCode = 2;
  exitCode = UsageError.exitCode;
}

export class RuleError extends Error {
  static exitCode = 1;
  exitCode = RuleError.exitCode;

  constructor(message, failures = []) {
    super(message);
    this.failures = failures;
  }
}

export class IOError extends Error {
  static exitCode = 3;
  exitCode = IOError.exitCode;
}
