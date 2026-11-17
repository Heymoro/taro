import { Button, Image, ScrollView, Text, View } from '@tarojs/components'
import React from 'react'

import { Action } from '../../../components/primitives'

export default function PhotoInput({
  photos,
  schema,
  mode,
  onAdd,
  onRemove,
  onRetry,
  onResume,
  onPreview,
  onReplace,
  activeUploadIds = [],
  photoBatchBusy = false,
  canReorder = false,
  canSelectPhotos = true,
  photoOrder
}) {
  const max = schema?.maxImages
  const configured = Number.isSafeInteger(max) && max > 0
  const canSelect = configured && canSelectPhotos
  const noPhotos = max === 0
  let count = '配置待就绪'
  if (photos.length) count = configured ? `${photos.length} / ${max} 张` : `已选 ${photos.length} 张`
  else if (noPhotos) count = '无需照片'
  else if (canSelect) count = mode === 'free' ? '选填' : '支持多张'
  const editing = !!photoOrder?.editing
  const action = (callback) => (photoOrder ? photoOrder.action(callback) : callback)
  const draggedPhoto = photos.find((photo) => photo.id === photoOrder?.drag?.slotId)
  const stopTouch = (event) => {
    photoOrder?.onPanelTouchStart(event)
    event.stopPropagation()
  }
  const tiles = photos.map((photo, index) => (
    <View
      className={`photo-tile${editing ? ' photo-order__slot' : ''}${
        photoOrder?.selectedId === photo.id && editing ? ' photo-order__slot--selected' : ''
      }${photoOrder?.drag?.targetIndex === index ? ' photo-order__slot--target' : ''}`}
      data-slot-id={photo.id}
      key={photo.id}
      {...(editing ? photoOrder.tileEvents(photo.id) : {})}
    >
      {!!photo.path && (
        <Image
          src={photo.path}
          className="photo-tile__image"
          mode="aspectFill"
          onClick={
            editing ? photoOrder.tileEvents(photo.id).onClick : action(() => onPreview(photo))
          }
        />
      )}
      <Text className="photo-order__number">图{index + 1}</Text>
      {!activeUploadIds.includes(photo.id) && photo.status === 'unavailable' && (
        <>
          <Button
            className="photo-tile__retry"
            onTouchStart={stopTouch}
            disabled={!canSelect}
            onClick={canSelect ? action(() => onReplace(photo.id)) : undefined}
          >
            补选照片
          </Button>
          <Text className="photo-tile__status">照片已失效</Text>
        </>
      )}
      {activeUploadIds.includes(photo.id) && <Text className="photo-tile__status">上传中</Text>}
      {!activeUploadIds.includes(photo.id) && ['pending', 'uploading'].includes(photo.status) && (
        photoBatchBusy ? (
          <Text className="photo-tile__status">等待上传</Text>
        ) : (
          <Button
            className="photo-tile__retry"
            onTouchStart={stopTouch}
            disabled={!canSelect}
            onClick={canSelect ? action(() => onResume(photo.id)) : undefined}
          >
            继续上传
          </Button>
        )
      )}
      {!activeUploadIds.includes(photo.id) && photo.status === 'failed' && (
        <Button
          className="photo-tile__retry"
          onTouchStart={stopTouch}
          disabled={!canSelect}
          onClick={canSelect ? action(() => onRetry(photo.id)) : undefined}
        >
          重试上传
        </Button>
      )}
      <Button
        className="photo-tile__remove"
        aria-label="移除照片"
        onClick={action(() => onRemove(photo.id))}
        onTouchStart={stopTouch}
      >
        ×
      </Button>
    </View>
  ))
  return (
    <View className="references" onTouchStart={photoOrder?.onPanelTouchStart}>
      <View className="row references__heading">
        <Text>我的照片</Text>
        <Text className="muted references__count">
          {count}
        </Text>
        {!!photos.length && (
          <Button
            className="text-button"
            disabled={!editing && !canReorder}
            onClick={editing ? photoOrder.done : photoOrder?.begin}
          >
            {editing ? '完成' : '整理'}
          </Button>
        )}
        {!photos.length && mode === 'free' && (
          <Button className="text-button" disabled={!canSelect} onClick={canSelect ? onAdd : undefined}>
            ＋ 添加我的照片
          </Button>
        )}
      </View>
      {!!photos.length && noPhotos && <Text className="small muted">无需照片</Text>}
      {!!photos.length &&
        (editing ? (
          <View className="photo-order">
            <Text className="muted photo-order__hint">选中照片后前后移动，也可长按拖动</Text>
            <View className="photo-order__grid">{tiles}</View>
            <View className="photo-order__actions">
              <Button
                className="text-button"
                disabled={photoOrder.previousDisabled}
                onClick={photoOrder.previous}
              >
                前移
              </Button>
              <Button
                className="text-button"
                disabled={photoOrder.nextDisabled}
                onClick={photoOrder.next}
              >
                后移
              </Button>
            </View>
            {photoOrder.drag && (
              <View
                className="photo-order__floating"
                style={{
                  left: `${photoOrder.drag.position.x}px`,
                  top: `${photoOrder.drag.position.y}px`
                }}
              >
                {!!draggedPhoto?.path && (
                  <Image src={draggedPhoto.path} className="photo-tile__image" mode="aspectFill" />
                )}
                <Text className="photo-order__number">
                  图{photos.findIndex((photo) => photo.id === photoOrder.drag.slotId) + 1}
                </Text>
              </View>
            )}
          </View>
        ) : (
          <ScrollView scrollX className="photo-strip" showScrollbar={false}>
            <View className="photo-strip__inner">
              {tiles}
              {configured && photos.length < max && (
                <Button className="photo-add" aria-label="继续添加照片" disabled={!canSelect} onClick={canSelect ? onAdd : undefined}>
                  ＋
                </Button>
              )}
            </View>
          </ScrollView>
        ))}
      {!photos.length && mode === 'effect' && (
        <Action quiet disabled={!canSelect} onClick={canSelect ? onAdd : undefined}>
          ＋ 添加我的照片
        </Action>
      )}
    </View>
  )
}
