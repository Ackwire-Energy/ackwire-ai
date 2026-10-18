import { useLocalSearchParams } from "expo-router";
import { ImageViewer } from "@/features/files/ImageViewer";

/**
 * A message's pictures, full screen over the conversation (presentation set in `_layout`):
 * `/images?files=<id>@<version>,…&at=<index>`.
 */
export default function ImagesRoute() {
  const { files, at } = useLocalSearchParams<{ files?: string; at?: string }>();
  return <ImageViewer files={files} at={at} />;
}
