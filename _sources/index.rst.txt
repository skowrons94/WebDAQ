WebDAQ — data acquisition for the LUNA experiment
=================================================

WebDAQ reads the CAEN digitizers, writes the data, shows the spectra while they
fill, records what the beam was doing and says something when a board stops.
This manual is written for the person on shift; the later chapters are for
whoever has to change the system.

The same material is available as a single PDF, built from ``manual/`` in the
repository.

.. toctree::
   :maxdepth: 2
   :caption: Taking data

   welcome.md
   installation.md
   example-session.md
   usage.md
   troubleshooting.md

.. toctree::
   :maxdepth: 2
   :caption: Subsystems

   caen-settings.md
   histograms-and-rois.md
   current-and-charge.md
   monitoring-and-alerts.md
   run-data.md
   elog.md

.. toctree::
   :maxdepth: 2
   :caption: How it works

   details.md
   directory-structure.md
   server-architecture.md
