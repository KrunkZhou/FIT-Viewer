import type { MapPoint, Position } from "../model";
import { FIT_EPOCH } from "../protocol/time";

const timeLabel = (time: number) =>
  new Date(FIT_EPOCH + time * 1000).toLocaleString();

export function pointDetails(
  point: MapPoint,
  name: string,
  route?: string,
): string {
  return [
    name,
    route,
    `${point.lat.toFixed(7)}, ${point.lon.toFixed(7)}`,
    point.time === undefined ? undefined : `Time: ${timeLabel(point.time)}`,
    point.distance === undefined
      ? undefined
      : `Distance: ${(point.distance / 1000).toFixed(2)} km`,
    point.elevation === undefined
      ? undefined
      : `Elevation: ${point.elevation.toFixed(1)} m`,
  ]
    .filter((value) => value !== undefined)
    .join("\n");
}

export function routeDetails(track: Position[], name: string): string {
  const start = track[0];
  const end = track.at(-1);
  const distance =
    start?.distance !== undefined && end?.distance !== undefined
      ? end.distance - start.distance
      : undefined;
  return [
    name,
    `${track.length.toLocaleString()} displayed GPS points`,
    start?.time === undefined ? undefined : `Start: ${timeLabel(start.time)}`,
    end?.time === undefined ? undefined : `End: ${timeLabel(end.time)}`,
    distance === undefined || distance < 0
      ? undefined
      : `Distance: ${(distance / 1000).toFixed(2)} km`,
  ]
    .filter((value) => value !== undefined)
    .join("\n");
}
