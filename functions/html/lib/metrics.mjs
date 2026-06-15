const NAMESPACE = "ChromiumPdf";

export const logEvent = (level, message, details = {}) => {
  const record = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...details,
  });
  const logger = console[level] ?? console.log;
  logger(record);
};

export const emitMetrics = (metrics, dimensions = {}) => {
  const metricDefinitions = Object.entries(metrics).map(([Name, value]) => ({
    Name,
    Unit: Name.endsWith("Ms")
      ? "Milliseconds"
      : Name.endsWith("Bytes")
        ? "Bytes"
        : "Count",
  }));

  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: NAMESPACE,
            Dimensions: [Object.keys(dimensions)],
            Metrics: metricDefinitions,
          },
        ],
      },
      ...dimensions,
      ...metrics,
    }),
  );
};
