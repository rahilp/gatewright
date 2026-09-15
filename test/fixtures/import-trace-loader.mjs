export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('/providers/') || specifier.includes('/adapters/')) process.stdout.write(`ADAPTER ${specifier}\n`);
  return nextResolve(specifier, context);
}
