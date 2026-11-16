/**
 * Options for `animation.ik.setTarget` as they came over the bridge. Values are forwarded as-is
 * (typed `never` only to satisfy the controller signature): `IkController.setTarget` is the one
 * place that validates `pole` and `weight`, so a wrong-typed `weight: "0.5"` is answered with
 * `ik.target.invalid-weight` instead of being dropped and running IK at full weight.
 */
export function ikTargetOptions(params: { readonly pole?: unknown; readonly weight?: unknown }): {
  pole?: never;
  weight?: number;
} {
  const options: { pole?: never; weight?: number } = {};
  if (params.pole !== undefined) options.pole = params.pole as never;
  if (params.weight !== undefined) options.weight = params.weight as number;
  return options;
}
