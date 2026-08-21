import { correlationAttributes, correlationForSpan } from "./correlation.mjs";

export default Object.freeze({
  onStart() {},
  onEnding(span) {
    const attributes = correlationAttributes(correlationForSpan(span));
    for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
  },
  onEnd() {},
  async forceFlush() {},
  async shutdown() {},
});
