import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { useActiveNode } from '@renderer/hooks/useNotesQuery'
import NotesSidebarHeader from '@renderer/pages/notes/NotesSidebarHeader'
import RecycleBinService, { type RecycleBinNoteItem } from '@renderer/services/RecycleBinService'
import { useAppSelector } from '@renderer/store'
import { selectSortType } from '@renderer/store/note'
import type { NotesSortType, NotesTreeNode } from '@renderer/types/note'
import type { MenuProps } from 'antd'
import { Dropdown, Modal } from 'antd'
import dayjs from 'dayjs'
import { Check, ChevronDown, ChevronRight, File, FilePlus, Folder, FolderClosed, FolderUp, Loader2, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import TreeNode from './components/TreeNode'
import {
  NotesActionsContext,
  NotesDragContext,
  NotesEditingContext,
  NotesSearchContext,
  NotesSelectionContext,
  NotesUIContext
} from './context/NotesContexts'
import { useFullTextSearch } from './hooks/useFullTextSearch'
import { useNotesDragAndDrop } from './hooks/useNotesDragAndDrop'
import { useNotesEditing } from './hooks/useNotesEditing'
import { useNotesFileUpload } from './hooks/useNotesFileUpload'
import { useNotesMenu } from './hooks/useNotesMenu'

interface NotesSidebarProps {
  onCreateFolder: (name: string, targetFolderId?: string) => void
  onCreateNote: (name: string, targetFolderId?: string) => void
  onSelectNode: (node: NotesTreeNode) => void
  onDeleteNode: (nodeId: string) => Promise<void> | void
  onDeleteNodes: (nodeIds: string[]) => Promise<void> | void
  onRenameNode: (nodeId: string, newName: string) => void
  onToggleExpanded: (nodeId: string) => void
  onToggleStar: (nodeId: string) => void
  onMoveNode: (sourceNodeId: string, targetNodeId: string, position: 'before' | 'after' | 'inside') => void
  onSortNodes: (sortType: NotesSortType) => void
  onUploadFiles: (files: File[]) => void
  notesTree: NotesTreeNode[]
  selectedFolderId?: string | null
}

const NotesSidebar: FC<NotesSidebarProps> = ({
  onCreateFolder,
  onCreateNote,
  onSelectNode,
  onDeleteNode,
  onDeleteNodes,
  onRenameNode,
  onToggleExpanded,
  onToggleStar,
  onMoveNode,
  onSortNodes,
  onUploadFiles,
  notesTree,
  selectedFolderId
}) => {
  const { t } = useTranslation()
  const { activeNode } = useActiveNode(notesTree)
  const sortType = useAppSelector(selectSortType)

  const [isShowStarred, setIsShowStarred] = useState(false)
  const [isShowSearch, setIsShowSearch] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [isDragOverSidebar, setIsDragOverSidebar] = useState(false)
  const [openDropdownKey, setOpenDropdownKey] = useState<string | null>(null)
  const [isManageMode, setIsManageMode] = useState(false)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())
  const [recentDeletedNotes, setRecentDeletedNotes] = useState<RecycleBinNoteItem[]>([])
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false)
  const [expandedDeletedNoteIds, setExpandedDeletedNoteIds] = useState<Set<string>>(new Set())
  const [isRecycleBinManageMode, setIsRecycleBinManageMode] = useState(false)
  const [selectedRecycleBinNoteEntryIds, setSelectedRecycleBinNoteEntryIds] = useState<Set<string>>(new Set())

  const notesTreeRef = useRef<NotesTreeNode[]>(notesTree)
  const virtualListRef = useRef<any>(null)
  const trimmedSearchKeyword = useMemo(() => searchKeyword.trim(), [searchKeyword])
  const hasSearchKeyword = trimmedSearchKeyword.length > 0

  const loadRecentDeletedNotes = useCallback(async () => {
    const items = await RecycleBinService.listNotes()
    setRecentDeletedNotes(items)
  }, [])

  const { editingNodeId, renamingNodeIds, newlyRenamedNodeIds, inPlaceEdit, handleStartEdit, handleAutoRename } =
    useNotesEditing({ onRenameNode })

  const {
    draggedNodeId,
    dragOverNodeId,
    dragPosition,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd
  } = useNotesDragAndDrop({ onMoveNode })

  const { handleDropFiles, handleSelectFiles, handleSelectFolder } = useNotesFileUpload({
    onUploadFiles,
    setIsDragOverSidebar
  })

  const handleDeleteNodeWithRecycleRefresh = useCallback(
    async (nodeId: string) => {
      await onDeleteNode(nodeId)
      await loadRecentDeletedNotes()
    },
    [loadRecentDeletedNotes, onDeleteNode]
  )

  const handleDeleteNodesWithRecycleRefresh = useCallback(
    async (nodeIds: string[]) => {
      await onDeleteNodes(nodeIds)
      await loadRecentDeletedNotes()
    },
    [loadRecentDeletedNotes, onDeleteNodes]
  )

  const { getMenuItems } = useNotesMenu({
    renamingNodeIds,
    onCreateNote,
    onCreateFolder,
    onRenameNode,
    onToggleStar,
    onDeleteNode: handleDeleteNodeWithRecycleRefresh,
    onDeleteNodes: handleDeleteNodesWithRecycleRefresh,
    onSelectNode,
    handleStartEdit,
    handleAutoRename,
    activeNode,
    selectedNodeIds
  })

  const searchOptions = useMemo(
    () => ({
      debounceMs: 300,
      maxResults: 100,
      contextLength: 50,
      caseSensitive: false,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      enabled: isShowSearch
    }),
    [isShowSearch]
  )

  const {
    search,
    cancel,
    reset,
    isSearching,
    results: searchResults,
    stats: searchStats
  } = useFullTextSearch(searchOptions)

  useEffect(() => {
    notesTreeRef.current = notesTree
  }, [notesTree])

  useEffect(() => {
    void loadRecentDeletedNotes()
  }, [loadRecentDeletedNotes])

  useEffect(() => {
    if (!isShowSearch) {
      reset()
      return
    }

    if (hasSearchKeyword) {
      search(notesTreeRef.current, trimmedSearchKeyword)
    } else {
      reset()
    }
  }, [isShowSearch, hasSearchKeyword, trimmedSearchKeyword, search, reset])

  // --- Logic ---

  const handleCreateFolder = useCallback(() => {
    onCreateFolder(t('notes.untitled_folder'))
  }, [onCreateFolder, t])

  const handleCreateNote = useCallback(() => {
    onCreateNote(t('notes.untitled_note'))
  }, [onCreateNote, t])

  const handleToggleStarredView = useCallback(() => {
    setIsManageMode(false)
    setSelectedNodeIds(new Set())
    setIsShowStarred(!isShowStarred)
  }, [isShowStarred])

  const handleToggleSearchView = useCallback(() => {
    setIsManageMode(false)
    setSelectedNodeIds(new Set())
    setIsShowSearch(!isShowSearch)
  }, [isShowSearch])

  const handleToggleManageMode = useCallback(() => {
    setIsManageMode((prev) => !prev)
    setSelectedNodeIds(new Set())
  }, [])

  const handleSelectSortType = useCallback(
    (selectedSortType: NotesSortType) => {
      onSortNodes(selectedSortType)
    },
    [onSortNodes]
  )

  const getEmptyAreaMenuItems = useCallback((): MenuProps['items'] => {
    return [
      {
        label: t('notes.new_note'),
        key: 'new_note',
        icon: <FilePlus size={14} />,
        onClick: handleCreateNote
      },
      {
        label: t('notes.new_folder'),
        key: 'new_folder',
        icon: <Folder size={14} />,
        onClick: handleCreateFolder
      },
      { type: 'divider' },
      {
        label: t('notes.upload_files'),
        key: 'upload_files',
        icon: <Upload size={14} />,
        onClick: handleSelectFiles
      },
      {
        label: t('notes.upload_folder'),
        key: 'upload_folder',
        icon: <FolderUp size={14} />,
        onClick: handleSelectFolder
      }
    ]
  }, [t, handleCreateNote, handleCreateFolder, handleSelectFiles, handleSelectFolder])

  // Flatten tree nodes for virtualization and filtering
  const flattenedNodes = useMemo(() => {
    const flattenForVirtualization = (
      nodes: NotesTreeNode[],
      depth: number = 0
    ): Array<{ node: NotesTreeNode; depth: number }> => {
      let result: Array<{ node: NotesTreeNode; depth: number }> = []

      for (const node of nodes) {
        result.push({ node, depth })

        // Include children only if the folder is expanded
        if (node.type === 'folder' && node.expanded && node.children && node.children.length > 0) {
          result = [...result, ...flattenForVirtualization(node.children, depth + 1)]
        }
      }
      return result
    }

    const flattenForFiltering = (nodes: NotesTreeNode[]): NotesTreeNode[] => {
      let result: NotesTreeNode[] = []

      for (const node of nodes) {
        if (isShowStarred) {
          if (node.type === 'file' && node.isStarred) {
            result.push(node)
          }
        }
        if (node.children && node.children.length > 0) {
          result = [...result, ...flattenForFiltering(node.children)]
        }
      }
      return result
    }

    if (isShowSearch) {
      if (hasSearchKeyword) {
        return searchResults.map((result) => ({ node: result, depth: 0 }))
      }
      return [] // 鎼滅储鍏抽敭璇嶄负绌?
    }

    if (isShowStarred) {
      const filteredNodes = flattenForFiltering(notesTree)
      return filteredNodes.map((node) => ({ node, depth: 0 }))
    }

    return flattenForVirtualization(notesTree)
  }, [notesTree, isShowStarred, isShowSearch, hasSearchKeyword, searchResults])

  const selectableNodeIds = useMemo(
    () => flattenedNodes.map(({ node }) => node.id).filter((nodeId) => nodeId !== 'hint-node'),
    [flattenedNodes]
  )

  const isAllSelected = useMemo(() => {
    return selectableNodeIds.length > 0 && selectableNodeIds.every((nodeId) => selectedNodeIds.has(nodeId))
  }, [selectableNodeIds, selectedNodeIds])

  const handleToggleNodeSelection = useCallback((nodeId: string) => {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  const handleSelectAllToggle = useCallback(() => {
    setSelectedNodeIds(isAllSelected ? new Set() : new Set(selectableNodeIds))
  }, [isAllSelected, selectableNodeIds])

  const handleDeleteSelected = useCallback(() => {
    if (selectedNodeIds.size === 0) {
      return
    }

    window.modal.confirm({
      title: t('common.batch_delete'),
      content: t('common.selectedItems', { count: selectedNodeIds.size }),
      centered: true,
      okButtonProps: { danger: true },
      onOk: async () => {
        await handleDeleteNodesWithRecycleRefresh(Array.from(selectedNodeIds))
        setSelectedNodeIds(new Set())
        setIsManageMode(false)
      }
    })
  }, [handleDeleteNodesWithRecycleRefresh, selectedNodeIds, t])

  const handleRestoreDeletedNote = useCallback(
    async (entryId: string) => {
      await RecycleBinService.restoreNote(entryId)
      await loadRecentDeletedNotes()
    },
    [loadRecentDeletedNotes]
  )

  const handleDeleteRecentNotePermanently = useCallback(
    async (entryId: string) => {
      window.modal.confirm({
        title: '彻底删除',
        content: '此笔记将从最近删除中彻底移除，且无法恢复。',
        centered: true,
        okButtonProps: { danger: true },
        onOk: async () => {
          await RecycleBinService.permanentlyDeleteNote(entryId)
          await loadRecentDeletedNotes()
        }
      })
    },
    [loadRecentDeletedNotes]
  )

  const isAllRecycleBinNotesSelected = useMemo(
    () =>
      recentDeletedNotes.length > 0 &&
      recentDeletedNotes.every((item) => selectedRecycleBinNoteEntryIds.has(item.entryId)),
    [recentDeletedNotes, selectedRecycleBinNoteEntryIds]
  )

  const handleToggleRecycleBinNoteSelection = useCallback((entryId: string) => {
    setSelectedRecycleBinNoteEntryIds((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
      }
      return next
    })
  }, [])

  const handleToggleSelectAllRecycleBinNotes = useCallback(() => {
    setSelectedRecycleBinNoteEntryIds(
      isAllRecycleBinNotesSelected ? new Set() : new Set(recentDeletedNotes.map((item) => item.entryId))
    )
  }, [isAllRecycleBinNotesSelected, recentDeletedNotes])

  const handleBatchDeleteRecycleBinNotes = useCallback(() => {
    if (selectedRecycleBinNoteEntryIds.size === 0) {
      return
    }

    window.modal.confirm({
      title: '批量彻底删除',
      content: `将彻底删除 ${selectedRecycleBinNoteEntryIds.size} 项，且无法恢复。`,
      centered: true,
      okButtonProps: { danger: true },
      onOk: async () => {
        for (const entryId of selectedRecycleBinNoteEntryIds) {
          await RecycleBinService.permanentlyDeleteNote(entryId)
        }

        setSelectedRecycleBinNoteEntryIds(new Set())
        setIsRecycleBinManageMode(false)
        await loadRecentDeletedNotes()
      }
    })
  }, [loadRecentDeletedNotes, selectedRecycleBinNoteEntryIds])

  const handleToggleDeletedNoteExpanded = useCallback((entryId: string) => {
    setExpandedDeletedNoteIds((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
      }
      return next
    })
  }, [])

  const renderDeletedNoteChildren = useCallback(
    (children: NonNullable<RecycleBinNoteItem['children']>, depth: number = 0): ReactNode => {
      return children.map((child) => (
        <DeletedNoteTreeNode key={`${child.type}-${child.id}`}>
          <DeletedNoteTreeItem style={{ paddingLeft: `${12 + depth * 18}px` }}>
            <DeletedNoteTreeLabel>
              {child.type === 'folder' ? <FolderClosed size={12} /> : <File size={12} />}
              <span>{child.name}</span>
            </DeletedNoteTreeLabel>
          </DeletedNoteTreeItem>
          {child.children && child.children.length > 0 && renderDeletedNoteChildren(child.children, depth + 1)}
        </DeletedNoteTreeNode>
      ))
    },
    []
  )

  useEffect(() => {
    setSelectedNodeIds((prev) => {
      const next = new Set(Array.from(prev).filter((nodeId) => selectableNodeIds.includes(nodeId)))
      const hasChanged = next.size !== prev.size || Array.from(next).some((nodeId) => !prev.has(nodeId))
      return hasChanged ? next : prev
    })
  }, [selectableNodeIds])

  useEffect(() => {
    if (isManageMode && selectableNodeIds.length === 0) {
      setIsManageMode(false)
      setSelectedNodeIds(new Set())
    }
  }, [isManageMode, selectableNodeIds.length])

  // Scroll to active node
  useEffect(() => {
    if (activeNode?.id && !isShowStarred && !isShowSearch && virtualListRef.current) {
      setTimeout(() => {
        const activeIndex = flattenedNodes.findIndex(({ node }) => node.id === activeNode.id)
        if (activeIndex !== -1) {
          virtualListRef.current?.scrollToIndex(activeIndex, {
            align: 'center',
            behavior: 'auto'
          })
        }
      }, 200)
    }
  }, [activeNode?.id, isShowStarred, isShowSearch, flattenedNodes])

  // Determine which items should be sticky (only folders in normal view)
  const isSticky = useCallback(
    (index: number) => {
      const item = flattenedNodes[index]
      if (!item) return false

      // Only folders should be sticky, and only in normal view (not search or starred)
      return item.node.type === 'folder' && !isShowSearch && !isShowStarred
    },
    [flattenedNodes, isShowSearch, isShowStarred]
  )

  // Get the depth of an item for hierarchical sticky positioning
  const getItemDepth = useCallback(
    (index: number) => {
      const item = flattenedNodes[index]
      return item?.depth ?? 0
    },
    [flattenedNodes]
  )

  const actionsValue = useMemo(
    () => ({
      getMenuItems,
      onSelectNode,
      onToggleExpanded,
      onDropdownOpenChange: setOpenDropdownKey
    }),
    [getMenuItems, onSelectNode, onToggleExpanded]
  )

  const selectionValue = useMemo(
    () => ({
      selectedFolderId,
      activeNodeId: activeNode?.id,
      isManageMode,
      selectedNodeIds,
      onToggleNodeSelection: handleToggleNodeSelection
    }),
    [selectedFolderId, activeNode?.id, isManageMode, selectedNodeIds, handleToggleNodeSelection]
  )

  const editingValue = useMemo(
    () => ({
      editingNodeId,
      renamingNodeIds,
      newlyRenamedNodeIds,
      inPlaceEdit
    }),
    [editingNodeId, renamingNodeIds, newlyRenamedNodeIds, inPlaceEdit]
  )

  const dragValue = useMemo(
    () => ({
      draggedNodeId,
      dragOverNodeId,
      dragPosition,
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onDragEnd: handleDragEnd
    }),
    [
      draggedNodeId,
      dragOverNodeId,
      dragPosition,
      handleDragStart,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      handleDragEnd
    ]
  )

  const searchValue = useMemo(
    () => ({
      searchKeyword: isShowSearch ? trimmedSearchKeyword : '',
      showMatches: isShowSearch
    }),
    [isShowSearch, trimmedSearchKeyword]
  )

  return (
    <NotesActionsContext value={actionsValue}>
      <NotesSelectionContext value={selectionValue}>
        <NotesEditingContext value={editingValue}>
          <NotesDragContext value={dragValue}>
            <NotesSearchContext value={searchValue}>
              <NotesUIContext value={{ openDropdownKey }}>
                <SidebarContainer
                  onDragOver={(e) => {
                    e.preventDefault()
                    if (!draggedNodeId) {
                      setIsDragOverSidebar(true)
                    }
                  }}
                  onDragLeave={() => setIsDragOverSidebar(false)}
                  onDrop={(e) => {
                    if (!draggedNodeId) {
                      void handleDropFiles(e)
                    }
                  }}>
                  <NotesSidebarHeader
                    isShowStarred={isShowStarred}
                    isShowSearch={isShowSearch}
                    isManageMode={isManageMode}
                    searchKeyword={searchKeyword}
                    selectedCount={selectedNodeIds.size}
                    isAllSelected={isAllSelected}
                    sortType={sortType}
                    onCreateFolder={handleCreateFolder}
                    onCreateNote={handleCreateNote}
                    onDeleteSelected={handleDeleteSelected}
                    onSelectAllToggle={handleSelectAllToggle}
                    onToggleManageMode={handleToggleManageMode}
                    onToggleStarredView={handleToggleStarredView}
                    onToggleSearchView={handleToggleSearchView}
                    onSetSearchKeyword={setSearchKeyword}
                    onSelectSortType={handleSelectSortType}
                  />

                  <NotesTreeContainer>
                    {isShowSearch && isSearching && (
                      <SearchStatusBar>
                        <Loader2 size={14} className="animate-spin" />
                        <span>{t('notes.search.searching')}</span>
                        <CancelButton onClick={cancel} title={t('common.cancel')}>
                          <X size={14} />
                        </CancelButton>
                      </SearchStatusBar>
                    )}
                    {isShowSearch && !isSearching && hasSearchKeyword && searchStats.total > 0 && (
                      <SearchStatusBar>
                        <span>
                          {t('notes.search.found_results', {
                            count: searchStats.total,
                            nameCount: searchStats.fileNameMatches,
                            contentCount: searchStats.contentMatches + searchStats.bothMatches
                          })}
                        </span>
                      </SearchStatusBar>
                    )}
                    <Dropdown
                      menu={{ items: getEmptyAreaMenuItems() }}
                      trigger={['contextMenu']}
                      open={openDropdownKey === 'empty-area'}
                      onOpenChange={(open) => setOpenDropdownKey(open ? 'empty-area' : null)}>
                      <DynamicVirtualList
                        ref={virtualListRef}
                        list={flattenedNodes}
                        estimateSize={() => 28}
                        itemContainerStyle={{ padding: '8px 8px 0 8px' }}
                        overscan={10}
                        isSticky={isSticky}
                        getItemDepth={getItemDepth}>
                        {({ node, depth }) => <TreeNode node={node} depth={depth} renderChildren={false} />}
                      </DynamicVirtualList>
                    </Dropdown>
                    {!isShowStarred && !isShowSearch && !isManageMode && (
                      <div style={{ padding: '0 8px', marginTop: '6px', marginBottom: '12px' }}>
                        <TreeNode
                          node={{
                            id: 'hint-node',
                            name: '',
                            type: 'hint',
                            treePath: '',
                            externalPath: '',
                            createdAt: '',
                            updatedAt: ''
                          }}
                          depth={0}
                          renderChildren={false}
                          onHintClick={handleSelectFolder}
                        />
                      </div>
                    )}
                    {recentDeletedNotes.length > 0 && (
                      <RecycleBinEntryWrap>
                        <RecycleBinEntryButton type="button" onClick={() => setIsRecycleBinOpen(true)}>
                          最近删除 ({recentDeletedNotes.length})
                        </RecycleBinEntryButton>
                      </RecycleBinEntryWrap>
                    )}
                  </NotesTreeContainer>

                  {isDragOverSidebar && <DragOverIndicator />}
                </SidebarContainer>
                <Modal
                  title="最近删除"
                  open={isRecycleBinOpen}
                  onCancel={() => {
                    setIsRecycleBinOpen(false)
                    setIsRecycleBinManageMode(false)
                    setSelectedRecycleBinNoteEntryIds(new Set())
                  }}
                  footer={null}
                  width={520}
                  transitionName="animation-move-down"
                  centered>
                  <RecycleBinToolbar>
                    <RecycleBinToolbarButton
                      type="button"
                      onClick={() => {
                        setIsRecycleBinManageMode((prev) => !prev)
                        setSelectedRecycleBinNoteEntryIds(new Set())
                      }}>
                      {isRecycleBinManageMode ? '取消管理' : '批量删除'}
                    </RecycleBinToolbarButton>
                    {isRecycleBinManageMode && (
                      <>
                        <RecycleBinToolbarButton type="button" onClick={handleToggleSelectAllRecycleBinNotes}>
                          {isAllRecycleBinNotesSelected ? '取消全选' : '全选'}
                        </RecycleBinToolbarButton>
                        <RecycleBinToolbarButton
                          type="button"
                          danger
                          disabled={selectedRecycleBinNoteEntryIds.size === 0}
                          onClick={handleBatchDeleteRecycleBinNotes}>
                          彻底删除所选 ({selectedRecycleBinNoteEntryIds.size})
                        </RecycleBinToolbarButton>
                      </>
                    )}
                  </RecycleBinToolbar>
                  <RecycleBinModalList>
                    {recentDeletedNotes.map((item) => (
                      <RecentDeletedFolderGroup key={`tree-${item.entryId}`}>
                        {item.nodeType === 'folder' ? (
                          <>
                            <RecentDeletedItem
                              role="button"
                              tabIndex={0}
                              onClick={() => handleToggleDeletedNoteExpanded(item.entryId)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  handleToggleDeletedNoteExpanded(item.entryId)
                                }
                              }}>
                              {isRecycleBinManageMode && (
                                <RecentDeletedSelector
                                  type="button"
                                  aria-label="选择笔记文件夹"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleToggleRecycleBinNoteSelection(item.entryId)
                                  }}>
                                  {selectedRecycleBinNoteEntryIds.has(item.entryId) && <Check size={12} />}
                                </RecentDeletedSelector>
                              )}
                              <RecentDeletedMeta>
                                <RecentDeletedFolderTitleWrap>
                                  {expandedDeletedNoteIds.has(item.entryId) ? (
                                    <ChevronDown size={14} />
                                  ) : (
                                    <ChevronRight size={14} />
                                  )}
                                  <FolderClosed size={14} />
                                  <RecentDeletedName title={item.name}>{item.name}</RecentDeletedName>
                                </RecentDeletedFolderTitleWrap>
                                <RecentDeletedTime>{dayjs(item.deletedAt).format('MM/DD HH:mm')}</RecentDeletedTime>
                              </RecentDeletedMeta>
                              <RecentDeletedActions>
                                {!isRecycleBinManageMode && (
                                  <>
                                    <RecentDeletedActionButton
                                      type="button"
                                      title="恢复"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void handleRestoreDeletedNote(item.entryId)
                                      }}>
                                      <RotateCcw size={12} />
                                    </RecentDeletedActionButton>
                                    <RecentDeletedActionButton
                                      type="button"
                                      danger
                                      title="彻底删除"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        void handleDeleteRecentNotePermanently(item.entryId)
                                      }}>
                                      <Trash2 size={12} />
                                    </RecentDeletedActionButton>
                                  </>
                                )}
                              </RecentDeletedActions>
                            </RecentDeletedItem>
                            {expandedDeletedNoteIds.has(item.entryId) && item.children && item.children.length > 0 && (
                              <RecentDeletedChildren>{renderDeletedNoteChildren(item.children)}</RecentDeletedChildren>
                            )}
                          </>
                        ) : (
                          <RecentDeletedItem key={`file-${item.entryId}`}>
                            {isRecycleBinManageMode && (
                              <RecentDeletedSelector
                                type="button"
                                aria-label="选择笔记"
                                onClick={() => handleToggleRecycleBinNoteSelection(item.entryId)}>
                                {selectedRecycleBinNoteEntryIds.has(item.entryId) && <Check size={12} />}
                              </RecentDeletedSelector>
                            )}
                            <RecentDeletedMeta>
                              <RecentDeletedFolderTitleWrap>
                                <File size={14} />
                                <RecentDeletedName title={item.name}>{item.name}</RecentDeletedName>
                              </RecentDeletedFolderTitleWrap>
                              <RecentDeletedTime>{dayjs(item.deletedAt).format('MM/DD HH:mm')}</RecentDeletedTime>
                            </RecentDeletedMeta>
                            <RecentDeletedActions>
                              {!isRecycleBinManageMode && (
                                <>
                                  <RecentDeletedActionButton
                                    type="button"
                                    title="恢复"
                                    onClick={() => void handleRestoreDeletedNote(item.entryId)}>
                                    <RotateCcw size={12} />
                                  </RecentDeletedActionButton>
                                  <RecentDeletedActionButton
                                    type="button"
                                    danger
                                    title="彻底删除"
                                    onClick={() => void handleDeleteRecentNotePermanently(item.entryId)}>
                                    <Trash2 size={12} />
                                  </RecentDeletedActionButton>
                                </>
                              )}
                            </RecentDeletedActions>
                          </RecentDeletedItem>
                        )}
                      </RecentDeletedFolderGroup>
                    ))}
                  </RecycleBinModalList>
                </Modal>
              </NotesUIContext>
            </NotesSearchContext>
          </NotesDragContext>
        </NotesEditingContext>
      </NotesSelectionContext>
    </NotesActionsContext>
  )
}

export const SidebarContainer = styled.div`
  width: 250px;
  min-width: 250px;
  height: calc(100vh - var(--navbar-height));
  background-color: var(--color-background);
  border-right: 0.5px solid var(--color-border);
  border-top-left-radius: 10px;
  display: flex;
  flex-direction: column;
  position: relative;
  isolation: isolate;
`

export const NotesTreeContainer = styled.div`
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--navbar-height) - 45px);
`

export const DragOverIndicator = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-color: rgba(0, 123, 255, 0.1);
  border: 2px dashed rgba(0, 123, 255, 0.6);
  border-radius: 4px;
  pointer-events: none;
`

export const DropHintText = styled.div`
  color: var(--color-text-3);
  font-size: 12px;
  font-style: italic;
`

// 鎼滅储鐩稿叧鏍峰紡
export const SearchStatusBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: var(--color-background-soft);
  border-bottom: 0.5px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text-2);

  .animate-spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
`

export const CancelButton = styled.button`
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background-color: transparent;
  color: var(--color-text-3);
  cursor: pointer;
  border-radius: 3px;
  transition: all 0.2s ease;

  &:hover {
    background-color: var(--color-background-mute);
    color: var(--color-text);
  }

  &:active {
    background-color: var(--color-active);
  }
`

const RecycleBinEntryWrap = styled.div`
  margin: 0 8px 12px;
`

const RecycleBinEntryButton = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 10px;
  border: none;
  border-radius: 12px;
  background: var(--color-background-soft);
  color: var(--color-text-2);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;

  &:hover {
    background: var(--color-background-mute);
    color: var(--color-text);
  }
`

const RecycleBinModalList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 60vh;
  overflow-y: auto;
`

const RecycleBinToolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
`

const RecycleBinToolbarButton = styled.button<{ danger?: boolean; disabled?: boolean }>`
  border: none;
  border-radius: 999px;
  padding: 6px 12px;
  background: ${({ danger }) => (danger ? 'rgba(220, 38, 38, 0.12)' : 'var(--color-background-soft)')};
  color: ${({ danger }) => (danger ? '#dc2626' : 'var(--color-text-2)')};
  font-size: 12px;
  font-weight: 500;
  cursor: ${({ disabled }) => (disabled ? 'not-allowed' : 'pointer')};
  opacity: ${({ disabled }) => (disabled ? 0.45 : 1)};

  &:hover {
    background: ${({ danger }) => (danger ? 'rgba(220, 38, 38, 0.16)' : 'var(--color-background-mute)')};
    color: ${({ danger }) => (danger ? '#b91c1c' : 'var(--color-text)')};
  }
`

const RecentDeletedFolderGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const RecentDeletedItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--color-background-soft);
`

const RecentDeletedSelector = styled.button`
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border: 1px solid rgba(15, 23, 42, 0.15);
  border-radius: 6px;
  background: #ffffff;
  color: #16a34a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
`

const RecentDeletedFolderTitleWrap = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const RecentDeletedMeta = styled.div`
  flex: 1;
  min-width: 0;
`

const RecentDeletedName = styled.div`
  font-size: 12px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const RecentDeletedTime = styled.div`
  margin-top: 2px;
  font-size: 11px;
  color: var(--color-text-3);
`

const RecentDeletedChildren = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 18px;
`

const RecentDeletedActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
`

const DeletedNoteTreeNode = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const DeletedNoteTreeItem = styled.div`
  display: flex;
  align-items: center;
  min-height: 28px;
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--color-background);
`

const DeletedNoteTreeLabel = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: var(--color-text-2);

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const RecentDeletedActionButton = styled.button<{ danger?: boolean }>`
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: ${(props) => (props.danger ? 'var(--color-error)' : 'var(--color-text-2)')};
  cursor: pointer;

  &:hover {
    background: var(--color-background-mute);
    color: ${(props) => (props.danger ? 'var(--color-error)' : 'var(--color-text)')};
  }
`

export default memo(NotesSidebar)

