function compute(): number {
  const total = 40 + 2;
  return total;
}
setTimeout(() => compute(), 100);
setTimeout(() => process.exit(0), 500);
