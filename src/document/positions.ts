import { Profile } from "@garmin/fitsdk";
import type { Position, RawValue } from "../model";

export function positionFields(message: number) {
  const fields = Object.values(Profile.messages[message]?.fields ?? {});
  const latitude = fields.find(
    (field) =>
      field.name === "positionLat" || field.name === "startPositionLat",
  );
  const longitude = fields.find(
    (field) =>
      field.name === "positionLong" || field.name === "startPositionLong",
  );
  if (!latitude || !longitude) return;
  return {
    latitude: latitude.num,
    longitude: longitude.num,
    name: fields.find((field) => field.name === "name")?.num,
    timestamp: fields.find((field) => field.name === "timestamp")?.num,
  };
}

export function positionCoordinates(
  latitude: RawValue | undefined,
  longitude: RawValue | undefined,
): Pick<Position, "lat" | "lon"> | undefined {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return;
  return { lat: latitude, lon: longitude };
}
