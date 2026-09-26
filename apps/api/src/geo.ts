import { AppError } from "./errors";

export type Bbox = [number, number, number, number];

export function bboxFromString(value: string): Bbox {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox must contain four numbers");
  }
  const [minLon, minLat, maxLon, maxLat] = parts as Bbox;
  if (minLon === maxLon || minLat >= maxLat) throw new AppError(400, "VALIDATION_FAILED", "Invalid bbox order");
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox is outside valid longitude/latitude ranges");
  }
  const longitudeSpan = minLon > maxLon ? 360 - minLon + maxLon : maxLon - minLon;
  if (longitudeSpan > 5 || maxLat - minLat > 5) throw new AppError(400, "VALIDATION_FAILED", "bbox is too large");
  return [minLon, minLat, maxLon, maxLat];
}

/** 生成 bbox 相交条件（处理反经线跨越），参数占位符从 startIndex 开始。 */
export function bboxCondition(bbox: Bbox, startIndex: number): string {
  const [minLon, , maxLon] = bbox;
  if (minLon > maxLon) {
    return `(
      ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($${startIndex}, $${startIndex + 1}, 180, $${startIndex + 3}), 4326)::geography)
      OR ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope(-180, $${startIndex + 1}, $${startIndex + 2}, $${startIndex + 3}), 4326)::geography)
    )`;
  }
  return `ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($${startIndex}, $${startIndex + 1}, $${startIndex + 2}, $${startIndex + 3}), 4326)::geography)`;
}
