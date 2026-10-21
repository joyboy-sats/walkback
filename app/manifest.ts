import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Walkback",
    short_name: "Walkback",
    description: "Walkback — we keep the receipts",
    start_url: "/",
    display: "standalone",
    background_color: "#08080a",
    theme_color: "#08080a",
    icons: [
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icon-180.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
