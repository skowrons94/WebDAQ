# WebDAQ manual.
#
#   make          build webdaq-manual.pdf (twice, for the table of contents)
#   make clean    remove the build products, keep the PDF
#   make distclean remove the PDF too
#
# Needs a TeX installation with pdflatex; latexmk is used when available because
# it decides by itself how many passes the cross-references need.

MAIN    = webdaq-manual
LATEXMK = $(shell command -v latexmk 2>/dev/null)

.PHONY: all clean distclean

all: $(MAIN).pdf

ifneq ($(LATEXMK),)
$(MAIN).pdf: $(MAIN).tex
	latexmk -pdf -interaction=nonstopmode -halt-on-error $(MAIN).tex
else
$(MAIN).pdf: $(MAIN).tex
	pdflatex -interaction=nonstopmode -halt-on-error $(MAIN).tex
	pdflatex -interaction=nonstopmode -halt-on-error $(MAIN).tex
endif

clean:
	rm -f $(MAIN).aux $(MAIN).log $(MAIN).out $(MAIN).toc $(MAIN).fls \
	      $(MAIN).fdb_latexmk $(MAIN).synctex.gz

distclean: clean
	rm -f $(MAIN).pdf
