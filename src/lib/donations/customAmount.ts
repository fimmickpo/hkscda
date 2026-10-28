/**
 * The `step` of the donation form's custom amount field.
 *
 * Donors give whole dollars. A development build also takes cents, because the PayMe sandbox picks
 * its scenario from the cents of the amount (.81 pays, .77 fails) and those cannot be typed
 * otherwise. Two decimals at most: the form turns the amount into whole cents, and a finer step
 * would be rounded without telling the donor.
 */
export function customAmountStep(allowCents: boolean): "1" | "0.01" {
  return allowCents ? "0.01" : "1";
}
