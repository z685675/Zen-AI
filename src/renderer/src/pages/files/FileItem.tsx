import {
  FileExcelFilled,
  FileImageFilled,
  FileMarkdownFilled,
  FilePdfFilled,
  FilePptFilled,
  FileTextFilled,
  FileUnknownFilled,
  FileWordFilled,
  FileZipFilled,
  FolderOpenFilled,
  GlobalOutlined,
  LinkOutlined,
  VideoCameraFilled
} from '@ant-design/icons'
import { videoExts } from '@shared/config/constant'
import { Flex } from 'antd'
import React, { memo } from 'react'
import styled from 'styled-components'

interface FileItemProps {
  fileInfo: {
    icon?: React.ReactNode
    name: React.ReactNode | string
    ext: string
    extra?: React.ReactNode | string
    actions: React.ReactNode
  }
  style?: React.CSSProperties
}

const getFileIcon = (type?: string) => {
  if (!type) return <FileUnknownFilled />

  const ext = type.toLowerCase()

  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) {
    return <FileImageFilled />
  }

  if (['.doc', '.docx'].includes(ext)) {
    return <FileWordFilled />
  }
  if (['.xls', '.xlsx'].includes(ext)) {
    return <FileExcelFilled />
  }
  if (['.ppt', '.pptx'].includes(ext)) {
    return <FilePptFilled />
  }
  if (ext === '.pdf') {
    return <FilePdfFilled />
  }
  if (['.md', '.markdown'].includes(ext)) {
    return <FileMarkdownFilled />
  }

  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) {
    return <FileZipFilled />
  }

  if (['.txt', '.json', '.log', '.yml', '.yaml', '.xml', '.csv'].includes(ext)) {
    return <FileTextFilled />
  }

  if (['.url'].includes(ext)) {
    return <LinkOutlined />
  }

  if (['.sitemap'].includes(ext)) {
    return <GlobalOutlined />
  }

  if (['.folder'].includes(ext)) {
    return <FolderOpenFilled />
  }

  if (videoExts.includes(ext)) {
    return <VideoCameraFilled />
  }

  return <FileUnknownFilled />
}

const FileItem: React.FC<FileItemProps> = ({ fileInfo, style }) => {
  const { name, ext, extra, actions, icon } = fileInfo

  return (
    <FileItemCard style={style}>
      <CardContent>
        <FileIcon>{icon || getFileIcon(ext)}</FileIcon>
        <Flex vertical justify="center" gap={0} flex={1} style={{ width: '0px' }}>
          <FileName>{name}</FileName>
          {extra && <FileInfo>{extra}</FileInfo>}
        </Flex>
        <FileActions>{actions}</FileActions>
      </CardContent>
    </FileItemCard>
  )
}

const FileItemCard = styled.div`
  border-radius: var(--zen-radius-md);
  overflow: hidden;
  border: 0;
  background: var(--zen-glass-card);
  backdrop-filter: blur(20px) saturate(155%);
  -webkit-backdrop-filter: blur(20px) saturate(155%);
  box-shadow: var(--zen-shadow-card);
  flex-shrink: 0;
  transition:
    box-shadow 180ms ease,
    background 160ms ease,
    transform 140ms ease;

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-0.5px);
  }
`

const CardContent = styled.div`
  padding: 10px 10px 10px 16px;
  display: flex;
  align-items: center;
  gap: 14px;
`

const FileIcon = styled.div`
  width: 38px;
  height: 38px;
  border-radius: var(--zen-radius-sm);
  background: var(--zen-bg-subtle);
  color: var(--zen-text-2);
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
`

const FileName = styled.div`
  font-size: 14px;
  font-weight: 500;
  color: var(--zen-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: color 0.15s ease;
  span {
    font-size: 14px;
  }
  &:hover {
    color: var(--color-primary);
  }
`

const FileInfo = styled.div`
  font-size: 12px;
  color: var(--zen-text-3);
  margin-top: 2px;
`

const FileActions = styled.div`
  max-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
`

export default memo(FileItem)
