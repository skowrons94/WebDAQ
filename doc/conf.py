# Sphinx configuration for the WebDAQ documentation.
#
# The pages are MyST Markdown so that they read as well in the repository as on
# the published site. GitHub Actions builds this directory on every push and
# deploys it from main (see .github/workflows/documentation.yml).

project = 'WebDAQ'
copyright = '2026, LUNA collaboration'
author = 'A. Compagnucci and J. Skowronski'
release = '5.0'

extensions = ['myst_parser']

# The chapters link to each other's sections, including third-level headings, so
# anchors have to be generated for them.
myst_heading_anchors = 3
myst_enable_extensions = ['colon_fence', 'deflist']

templates_path = []
exclude_patterns = ['_build', 'Thumbs.db', '.DS_Store']

html_theme = 'sphinx_rtd_theme'
html_title = 'WebDAQ 5.0'
# No custom CSS or templates: the directories would have to exist, and every
# build warned about them.
html_static_path = []
