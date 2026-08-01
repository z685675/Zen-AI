export const MANAGED_PYTHON_VERSION = '3.12'
export const MANAGED_PYTHON_PROFILE_VERSION = '1'

export const MANAGED_PYTHON_PACKAGES = [
  { id: 'numpy', requirement: 'numpy>=2.1,<3', importName: 'numpy' },
  { id: 'pandas', requirement: 'pandas>=2.2,<3', importName: 'pandas' },
  { id: 'openpyxl', requirement: 'openpyxl>=3.1,<4', importName: 'openpyxl' },
  { id: 'xlsxwriter', requirement: 'xlsxwriter>=3.2,<4', importName: 'xlsxwriter' },
  { id: 'matplotlib', requirement: 'matplotlib>=3.9,<4', importName: 'matplotlib' },
  { id: 'pillow', requirement: 'pillow>=11,<13', importName: 'PIL' },
  { id: 'pypdf', requirement: 'pypdf>=5,<7', importName: 'pypdf' },
  { id: 'pymupdf', requirement: 'pymupdf>=1.24,<2', importName: 'pymupdf' },
  { id: 'python-docx', requirement: 'python-docx>=1.1,<2', importName: 'docx' },
  { id: 'python-pptx', requirement: 'python-pptx>=1.0,<2', importName: 'pptx' }
] as const

export type ManagedPythonPackageId = (typeof MANAGED_PYTHON_PACKAGES)[number]['id']
