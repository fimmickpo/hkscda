/**
 * The `step` of the donation form's custom amount field.
 *
 * Donors give whole dollars. A development build also takes cents, and so does any build that sets
 * VITE_PUBLIC_ALLOW_CENT_AMOUNTS=true, because the PayMe sandbox picks its scenario from the cents of
 * the amount (.81 pays, .77 fails) and those cannot be typed otherwise. Two decimals at most: the
 * form turns the amount into whole cents, and a finer step would be rounded without telling the donor.
 */
export function customAmountStep(build: {
  development: boolean;
  allowCentsFlag?: string;
}): "1" | "0.01" {
  return build.development || build.allowCentsFlag === "true" ? "0.01" : "1";
}
