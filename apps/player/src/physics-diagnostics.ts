import type { PhysicsSceneDiagnostic } from "@kinetra/physics-rapier";

export type PhysicsDiagnosticLogLevel = "warning";

export type PhysicsDiagnosticSink = (
  level: PhysicsDiagnosticLogLevel,
  message: string,
  data: Record<string, unknown>,
) => void;

/**
 * Turns a structured physics scene diagnostic (a collider that fell back to box/capsule) into a
 * runtime log entry. The stable `code` is the log message so tools can match on it; every field a
 * client needs to act on (entity, declared shape, fallback, remediation) travels in `data`.
 */
export function logPhysicsSceneDiagnostic(
  sink: PhysicsDiagnosticSink,
  diagnostic: PhysicsSceneDiagnostic,
): void {
  sink("warning", diagnostic.code, {
    entityId: diagnostic.entityId,
    shape: diagnostic.shape,
    source: diagnostic.source,
    bodyType: diagnostic.bodyType,
    fallback: diagnostic.fallback,
    message: diagnostic.message,
    remediation: diagnostic.remediation,
  });
}
