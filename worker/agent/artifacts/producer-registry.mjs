const REVIEW_TARGET_CONSUME = Object.freeze({
  producerId: "review-target-consume",
  producerVersion: 1,
  allowedPurposes: Object.freeze(["review_target_chunk"]),
  allowedMediaTypes: Object.freeze(["text/plain;charset=utf-8"]),
  allowedEncodings: Object.freeze(["utf-8"]),
  maxContentBytes: 50 * 1024,
  textPolicyId: "review-text-lines-v1",
  transformVersions: Object.freeze([1]),
});

const PRODUCERS = new Map([
  [REVIEW_TARGET_CONSUME.producerId, REVIEW_TARGET_CONSUME],
]);

export function artifactProducerDefinition(producerId) {
  return PRODUCERS.get(producerId) ?? null;
}

export function artifactProducerIds() {
  return Object.freeze([...PRODUCERS.keys()]);
}
