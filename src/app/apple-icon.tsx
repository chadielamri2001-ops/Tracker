import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: 16,
          paddingBottom: 58,
          background: "#f59e0b"
        }}
      >
        <div style={{ width: 24, height: 38, background: "#2a1c05", borderRadius: 7 }} />
        <div style={{ width: 24, height: 66, background: "#2a1c05", borderRadius: 7 }} />
        <div style={{ width: 24, height: 94, background: "#2a1c05", borderRadius: 7 }} />
      </div>
    ),
    { ...size }
  );
}
