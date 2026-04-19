import { CheckOutlined } from '@ant-design/icons'
import type { NotesSortType } from '@renderer/types/note'
import type { MenuProps } from 'antd'
import { Dropdown, Input, Tooltip } from 'antd'
import { ArrowLeft, ArrowUpNarrowWide, CheckSquare, FilePlus2, FolderPlus, Search, Square, Star, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface NotesSidebarHeaderProps {
  isShowStarred: boolean
  isShowSearch: boolean
  isManageMode: boolean
  searchKeyword: string
  selectedCount: number
  isAllSelected: boolean
  sortType: NotesSortType
  onCreateFolder: () => void
  onCreateNote: () => void
  onDeleteSelected: () => void
  onSelectAllToggle: () => void
  onToggleManageMode: () => void
  onToggleStarredView: () => void
  onToggleSearchView: () => void
  onSetSearchKeyword: (keyword: string) => void
  onSelectSortType: (sortType: NotesSortType) => void
}

const NotesSidebarHeader: FC<NotesSidebarHeaderProps> = ({
  isShowStarred,
  isShowSearch,
  isManageMode,
  searchKeyword,
  selectedCount,
  isAllSelected,
  sortType,
  onCreateFolder,
  onCreateNote,
  onDeleteSelected,
  onSelectAllToggle,
  onToggleManageMode,
  onToggleStarredView,
  onToggleSearchView,
  onSetSearchKeyword,
  onSelectSortType
}) => {
  const { t } = useTranslation()

  const handleSortMenuClick: MenuProps['onClick'] = useCallback(
    (e) => {
      onSelectSortType(e.key as NotesSortType)
    },
    [onSelectSortType]
  )

  const sortMenuItems: Required<MenuProps>['items'] = [
    { label: t('notes.sort_a2z'), key: 'sort_a2z' },
    { label: t('notes.sort_z2a'), key: 'sort_z2a' },
    { type: 'divider' },
    { label: t('notes.sort_updated_desc'), key: 'sort_updated_desc' },
    { label: t('notes.sort_updated_asc'), key: 'sort_updated_asc' },
    { type: 'divider' },
    { label: t('notes.sort_created_desc'), key: 'sort_created_desc' },
    { label: t('notes.sort_created_asc'), key: 'sort_created_asc' }
  ]

  const sortMenuWithCheck = sortMenuItems
    .map((item) => {
      if (item) {
        return {
          ...item,
          icon: sortType === item.key ? <CheckOutlined /> : undefined,
          key: item.key
        }
      }
      return null
    })
    .filter(Boolean) as MenuProps['items']

  return (
    <SidebarHeader isStarView={isShowStarred} isSearchView={isShowSearch}>
      <HeaderActions>
        {!isShowStarred && !isShowSearch && !isManageMode && (
          <>
            <Tooltip title={t('notes.new_note')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onCreateNote}>
                <FilePlus2 size={18} />
              </ActionButton>
            </Tooltip>

            <Tooltip title={t('notes.new_folder')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onCreateFolder}>
                <FolderPlus size={18} />
              </ActionButton>
            </Tooltip>

            <Dropdown
              menu={{
                items: sortMenuWithCheck,
                onClick: handleSortMenuClick
              }}
              trigger={['click']}>
              <Tooltip title={t('assistants.presets.sorting.title')} mouseEnterDelay={0.8}>
                <ActionButton>
                  <ArrowUpNarrowWide size={18} />
                </ActionButton>
              </Tooltip>
            </Dropdown>

            <Tooltip title={t('notes.show_starred')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onToggleStarredView}>
                <Star size={18} />
              </ActionButton>
            </Tooltip>

            <Tooltip title={t('common.search')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onToggleSearchView}>
                <Search size={18} />
              </ActionButton>
            </Tooltip>

            <Tooltip title={t('common.batch_delete')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onToggleManageMode}>
                <CheckSquare size={18} />
              </ActionButton>
            </Tooltip>
          </>
        )}
        {isManageMode && (
          <>
            <Tooltip title={t('common.cancel')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onToggleManageMode}>
                <ArrowLeft size={18} />
              </ActionButton>
            </Tooltip>
            <SelectionSummary>{t('common.selectedItems', { count: selectedCount })}</SelectionSummary>
            <Tooltip title={isAllSelected ? t('common.deselect_all') : t('common.select_all')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onSelectAllToggle}>
                {isAllSelected ? <CheckSquare size={18} /> : <Square size={18} />}
              </ActionButton>
            </Tooltip>
            <Tooltip title={t('common.delete_selected')} mouseEnterDelay={0.8}>
              <ActionButton danger disabled={selectedCount === 0} onClick={onDeleteSelected}>
                <Trash2 size={18} />
              </ActionButton>
            </Tooltip>
          </>
        )}
        {isShowStarred && (
          <Tooltip title={t('common.back')} mouseEnterDelay={0.8}>
            <ActionButton onClick={onToggleStarredView}>
              <ArrowLeft size={18} />
            </ActionButton>
          </Tooltip>
        )}
        {isShowSearch && (
          <>
            <Tooltip title={t('common.back')} mouseEnterDelay={0.8}>
              <ActionButton onClick={onToggleSearchView}>
                <ArrowLeft size={18} />
              </ActionButton>
            </Tooltip>
            <SearchInput
              placeholder={t('knowledge.search_placeholder')}
              value={searchKeyword}
              onChange={(e) => onSetSearchKeyword(e.target.value)}
              allowClear
              size="small"
              autoFocus
            />
          </>
        )}
      </HeaderActions>
    </SidebarHeader>
  )
}

const SidebarHeader = styled.div<{ isStarView?: boolean; isSearchView?: boolean }>`
  padding: 8px 12px;
  border-bottom: 0.5px solid var(--color-border);
  display: flex;
  justify-content: ${(props) => (props.isStarView || props.isSearchView ? 'flex-start' : 'center')};
  height: var(--navbar-height);
`

const HeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
`

const ActionButton = styled.button.attrs({ type: 'button' })<{ danger?: boolean }>`
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 3px;
  color: ${(props) => (props.danger ? 'var(--color-error)' : 'var(--color-text-2)')};
  cursor: pointer;

  &:hover {
    background-color: var(--color-background-soft);
    color: ${(props) => (props.danger ? 'var(--color-error)' : 'var(--color-text)')};
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  &:disabled:hover {
    background-color: transparent;
    color: ${(props) => (props.danger ? 'var(--color-error)' : 'var(--color-text-2)')};
  }
`

const SelectionSummary = styled.div`
  flex: 1;
  min-width: 0;
  padding: 0 6px;
  font-size: 12px;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const SearchInput = styled(Input)`
  flex: 1;
  margin-left: 8px;
  max-width: 180px;

  .ant-input {
    font-size: 13px;
    border-radius: 4px;
  }
`

export default NotesSidebarHeader
