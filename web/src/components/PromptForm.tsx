import { useRef, useState } from 'react';
import { uploadFile } from '../api';

interface PromptFormProps {
  prompt: string;
  count: number;
  refs: string[];
  error: string;
  onPromptChange: (value: string) => void;
  onCountChange: (value: number) => void;
  onAddRef: (path: string) => void;
  onRemoveRef: (path: string) => void;
  onSubmit: () => void;
}

export function PromptForm(props: PromptFormProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const handleFile = async (file: File) => {
    setUploading(true);
    setUploadError('');
    try {
      const { path } = await uploadFile(file);
      props.onAddRef(path);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const submitDisabled = props.prompt.trim() === '' || uploading;

  return (
    <form
      className="prompt-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!submitDisabled) props.onSubmit();
      }}
    >
      <textarea
        className="prompt-input"
        value={props.prompt}
        rows={4}
        placeholder="生成したい画像の内容を書いてください"
        onChange={(e) => props.onPromptChange(e.target.value)}
      />
      <div className="form-row">
        <label className="count-label">
          枚数
          <input
            type="number"
            min={1}
            max={10}
            value={props.count}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= 10) props.onCountChange(n);
            }}
          />
        </label>
        <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? 'アップロード中…' : '参照画像を追加'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".png,.jpg,.jpeg,.webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void handleFile(file);
          }}
        />
        <button type="submit" className="submit" disabled={submitDisabled}>
          生成
        </button>
      </div>
      {props.refs.length > 0 && (
        <ul className="ref-chips">
          {props.refs.map((path) => (
            <li key={path} className="ref-chip" title={path}>
              <span className="ref-chip-name">{path.split('/').pop() ?? path}</span>
              <button
                type="button"
                aria-label={`参照画像 ${path} を外す`}
                onClick={() => props.onRemoveRef(path)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {(props.error !== '' || uploadError !== '') && (
        <p className="form-error">{props.error !== '' ? props.error : uploadError}</p>
      )}
    </form>
  );
}
