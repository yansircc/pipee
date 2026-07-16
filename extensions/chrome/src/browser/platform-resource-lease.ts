export async function withResourceLease<Resource, Result>(
  acquire: () => Promise<Resource>,
  use: (resource: Resource) => Promise<Result>,
  release: (resource: Resource) => Promise<void>,
): Promise<Result> {
  const resource = await acquire();
  const outcome = await use(resource).then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );
  const released = await release(resource).then(
    () => ({ ok: true as const }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );

  if (!released.ok) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.cause, released.cause],
        "Chrome resource use and release both failed",
      );
    }
    throw released.cause;
  }
  if (!outcome.ok) throw outcome.cause;
  return outcome.value;
}
