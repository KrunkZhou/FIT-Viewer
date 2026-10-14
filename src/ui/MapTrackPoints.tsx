import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { DomUtil, type LeafletMouseEvent } from "leaflet";
import type { Position } from "../model";

export function MapTrackPoints({
  tracks,
  hidden,
  colors,
  highlighted,
  onSelect,
}: {
  tracks: Position[][];
  hidden: number[];
  colors: string[];
  highlighted?: number;
  onSelect: (point: Position & { route: number }) => void;
}) {
  const map = useMap();
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.className = "viewer-map-route-points leaflet-zoom-hide";
    canvas.setAttribute("aria-hidden", "true");
    map.getPane("overlayPane")!.appendChild(canvas);
    let frame = 0;
    let columns = 1;
    const hits = new Map<
      number,
      { x: number; y: number; point: Position; route: number }
    >();
    const draw = () => {
      const size = map.getSize();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      columns = Math.max(1, Math.ceil(size.x / 3));
      hits.clear();
      let route = 0;
      let pointIndex = 0;
      const pixels = new Set<number>();
      const batch = () => {
        const deadline = performance.now() + 8;
        let processed = 0;
        while (route < tracks.length) {
          if (hidden.includes(route)) {
            route++;
            continue;
          }
          const track = tracks[route];
          context.fillStyle =
            highlighted === route ? "#f59e0b" : colors[route % colors.length];
          context.beginPath();
          while (pointIndex < track.length) {
            const point = track[pointIndex++];
            const pixel = map.latLngToContainerPoint([point.lat, point.lon]);
            if (
              pixel.x >= 0 &&
              pixel.y >= 0 &&
              pixel.x < size.x &&
              pixel.y < size.y
            ) {
              const key =
                Math.floor(pixel.x / 3) + Math.floor(pixel.y / 3) * columns;
              if (!pixels.has(key)) {
                pixels.add(key);
                hits.set(key, { x: pixel.x, y: pixel.y, point, route });
                const radius = highlighted === route ? 4 : 3;
                context.moveTo(pixel.x + radius, pixel.y);
                context.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
              }
            }
            if (++processed % 128 === 0 && performance.now() >= deadline) {
              context.fill();
              frame = requestAnimationFrame(batch);
              return;
            }
          }
          context.fill();
          pixels.clear();
          pointIndex = 0;
          route++;
        }
        canvas.dataset.pointCount = String(hits.size);
      };
      batch();
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const select = (event: LeafletMouseEvent) => {
      let closest: (Position & { route: number }) | undefined;
      let distance = 64;
      const column = Math.floor(event.containerPoint.x / 3);
      const row = Math.floor(event.containerPoint.y / 3);
      for (
        let x = Math.max(0, column - 3);
        x <= Math.min(columns - 1, column + 3);
        x++
      ) {
        for (let y = Math.max(0, row - 3); y <= row + 3; y++) {
          const hit = hits.get(x + y * columns);
          if (!hit) continue;
          const next =
            (hit.x - event.containerPoint.x) ** 2 +
            (hit.y - event.containerPoint.y) ** 2;
          if (next < distance) {
            distance = next;
            closest = { ...hit.point, route: hit.route };
          }
        }
      }
      if (closest) onSelect(closest);
    };
    map.on("moveend zoomend resize", schedule);
    map.on("click", select);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      map.off("moveend zoomend resize", schedule);
      map.off("click", select);
      canvas.remove();
    };
  }, [map, tracks, hidden, colors, highlighted, onSelect]);
  return null;
}
