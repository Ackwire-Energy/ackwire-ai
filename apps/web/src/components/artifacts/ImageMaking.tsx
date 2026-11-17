import { type AgentColor, PixelSpinner } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ImageSky } from "@/components/Sky";

/**
 * Where a picture an agent is making will show, while it makes it (`makingImage`): the box of a lone picture in a
 * reply, the picture forming out of the agent's sky (`ImageSky`), with the pixel orbit and "Criando a imagem…", until
 * the reply takes its place with the picture. Its image tool says nothing until it is done, so there is no progress to
 * show, only that it is on its way.
 */
export function ImageMaking({ color }: { color: AgentColor }) {
  const { t } = useTranslation();
  return (
    <div className="artifact-cards">
      <div className="image-making" role="status">
        <ImageSky color={color} />
        <span className="image-making__label ac-iconline">
          <PixelSpinner size={16} color={color} />
          {t("files.imageMaking")}
        </span>
      </div>
    </div>
  );
}
