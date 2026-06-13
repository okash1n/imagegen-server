import { imageUrl } from '../api';
import type { ImageItem } from '../api';

interface GalleryProps {
  images: ImageItem[];
  onSelect: (image: ImageItem) => void;
  /** lifts the image's server-side absolute path into the form refs */
  onUseAsRef: (path: string) => void;
}

export function Gallery({ images, onSelect, onUseAsRef }: GalleryProps) {
  if (images.length === 0) {
    return <p className="empty">画像はまだありません</p>;
  }
  return (
    <div className="gallery">
      {images.map((image) => (
        <figure key={image.id} className="card">
          <button type="button" className="card-thumb" onClick={() => onSelect(image)}>
            <img src={imageUrl(image.id)} alt={image.prompt} loading="lazy" />
          </button>
          <figcaption className="card-caption" title={image.prompt}>
            {image.prompt}
          </figcaption>
          <button type="button" className="card-action" onClick={() => onUseAsRef(image.path)}>
            これを元に再生成
          </button>
        </figure>
      ))}
    </div>
  );
}
