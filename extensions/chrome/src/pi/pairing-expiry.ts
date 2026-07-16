export const formatPairingTimeRemaining = (expiresAt: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
};
