#!/bin/bash

rsync -azv -e 'ssh -A -J skowrons@gate.pd.infn.it' /home/luna/19F+p_400kV/ luna@lunaserver:luna02/19F+p_400kV/