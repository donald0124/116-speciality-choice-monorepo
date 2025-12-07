// src/SortableItem.jsx
import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2 } from 'lucide-react'; // 1. 加回 Trash2

export function SortableItem(props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: props.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 999 : 'auto',
    opacity: isDragging ? 0.8 : 1,
    position: 'relative',
    touchAction: 'none',
  };

  return (
    <div ref={setNodeRef} style={style} className={`pref-item ${isDragging ? 'dragging' : ''}`}>
      
      <div className="pref-content">
        <div {...attributes} {...listeners} className="drag-handle">
          <GripVertical size={20} />
        </div>

        <span className="pref-index">{props.index + 1}</span>
        
        <span style={{ fontWeight: 'bold' }}>
          {props.data.label} 
          {props.data.isBound && <span className="tag-bound">綁定</span>}
        </span>
      </div>

      <button 
        className="remove-btn" 
        onPointerDown={e => e.stopPropagation()} 
        onClick={props.onRemove}
      >
        {/* 2. 改回 Trash2 元件，不需要傳 props，樣式交給 CSS 控制 */}
        <Trash2 />
      </button>
    </div>
  );
}