import { useState } from 'react';
import { imageUrl } from '../api';
import type { ImageItem } from '../api';

interface ImageModalProps {
  image: ImageItem;
  onClose: () => void;
}

export function ImageModal({ image, onClose }: ImageModalProps) {
  const [copyResult, setCopyResult] = useState('');

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(image.path);
      setCopyResult('コピーしました');
    } catch {
      setCopyResult('コピーに失敗しました(ブラウザのクリップボード権限を確認してください)');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <img className="modal-image" src={imageUrl(image.id)} alt={image.prompt} />
        <table className="meta-table">
          <tbody>
            <tr>
              <th>ID</th>
              <td>{image.id}</td>
            </tr>
            <tr>
              <th>種別</th>
              <td>{image.kind}</td>
            </tr>
            <tr>
              <th>prompt</th>
              <td>{image.prompt}</td>
            </tr>
            {image.revisedPrompt !== undefined && (
              <tr>
                <th>revisedPrompt</th>
                <td>{image.revisedPrompt}</td>
              </tr>
            )}
            {image.refImagePaths !== undefined && image.refImagePaths.length > 0 && (
              <tr>
                <th>参照画像</th>
                <td className="meta-path">{image.refImagePaths.join('\n')}</td>
              </tr>
            )}
            <tr>
              <th>生成日時</th>
              <td>{new Date(image.createdAt).toLocaleString()}</td>
            </tr>
            <tr>
              <th>所要時間</th>
              <td>{(image.durationMs / 1000).toFixed(1)} 秒</td>
            </tr>
            <tr>
              <th>パス</th>
              <td className="meta-path">{image.path}</td>
            </tr>
          </tbody>
        </table>
        <div className="modal-actions">
          <button type="button" onClick={() => void copyPath()}>
            パスをコピー
          </button>
          {copyResult !== '' && <span className="copy-result">{copyResult}</span>}
          <button type="button" className="modal-close" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
